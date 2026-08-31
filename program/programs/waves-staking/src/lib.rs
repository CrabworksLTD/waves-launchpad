//! WAVES burn-to-stake.
//!
//! The deal, exactly as the site describes it:
//!   - a creator launches a PAIR: a Core collection + a DBC token
//!   - holders BURN the paired token to activate an NFT — the burn is the
//!     stake, there is no unstake, no vault ever holds a user's assets
//!   - the creator's trading-fee share lands in the pool's reward vault
//!     (claimCreatorTradingFeeToReceiver pays it straight here, the keeper
//!     converts to the reward asset); activated NFTs split it by weight
//!
//! Distribution is the accumulator pattern and nothing else:
//!   acc_per_weight += deposit * PRECISION / total_weight      (on sync)
//!   owed           = weight * acc_per_weight / PRECISION - debt
//! Looping holders inside an instruction dies at scale; this never loops.
//!
//! The position is bound to the ASSET, not the wallet: the PDA is seeded on
//! the Core asset address, and claims verify the signer currently owns the
//! asset. A sold NFT keeps its tier — the buyer inherits the stream from the
//! moment of purchase (debt is settled to "now" whenever weight changes, and
//! an owner can only ever claim what accrued while the accumulator advanced).
//!
//! ⚠️ AUDIT REQUIRED before this touches mainnet money. Known review points
//! are marked AUDIT: inline.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Burn, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("DEg14RMeTu1q3SA88aiyeA55E4nqe5ZF667XQdUftnNY");

/// Fixed-point precision for the accumulator. u128 math throughout;
/// PRECISION chosen so (u64::MAX weight) * acc cannot overflow u128 within
/// any realistic vault volume.
pub const PRECISION: u128 = 1_000_000_000_000; // 1e12

#[program]
pub mod waves_staking {
    use super::*;

    /// One pool per pair. Permissionless: the pool's identity IS the
    /// (token_mint, collection) pair, so a second init of the same pair
    /// fails on the PDA. The reward vault is a token account owned by the
    /// pool PDA — the keeper (or anyone) deposits into it; nothing else
    /// about the pool trusts the caller.
    pub fn init_pool(ctx: Context<InitPool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.token_mint = ctx.accounts.token_mint.key();
        pool.collection = ctx.accounts.collection.key();
        pool.reward_mint = ctx.accounts.reward_mint.key();
        pool.vault = ctx.accounts.vault.key();
        pool.total_weight = 0;
        pool.acc_per_weight = 0;
        pool.vault_last = 0;
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Pull any new vault balance into the accumulator. Permissionless —
    /// the keeper calls it after depositing, but anyone may. Deposits made
    /// while total_weight == 0 sit in the vault until the first staker
    /// syncs afterwards (they roll forward rather than being lost).
    pub fn sync(ctx: Context<Sync>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let bal = ctx.accounts.vault.amount;
        let delta = bal.saturating_sub(pool.vault_last);
        if delta == 0 || pool.total_weight == 0 {
            // AUDIT: with zero weight we deliberately do NOT advance
            // vault_last, so the pending delta distributes once weight
            // exists. Confirm no griefing path via dust deposits.
            return Ok(());
        }
        pool.acc_per_weight = pool
            .acc_per_weight
            .checked_add((delta as u128).checked_mul(PRECISION).unwrap() / pool.total_weight as u128)
            .ok_or(StakeError::MathOverflow)?;
        pool.vault_last = bal;
        emit!(Synced { pool: pool.key(), deposited: delta });
        Ok(())
    }

    /// Burn `amount` of the paired token; the asset's weight rises by the
    /// same amount, permanently. The signer must currently own the asset.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakeError::ZeroAmount);
        verify_core_asset(
            &ctx.accounts.asset,
            &ctx.accounts.pool.collection,
            &ctx.accounts.owner.key(),
        )?;

        // settle the position to "now" before its weight changes, or the new
        // weight would claim history it wasn't staked for
        let pool = &mut ctx.accounts.pool;
        let pos = &mut ctx.accounts.position;
        if pos.asset == Pubkey::default() {
            pos.asset = ctx.accounts.asset.key();
            pos.bump = ctx.bumps.position;
        }
        let owed = settle(pool, pos)?;
        // AUDIT: owed is carried as credit rather than paid inside stake —
        // one token flow per instruction. pending_credit pays out on claim.
        pos.pending_credit = pos
            .pending_credit
            .checked_add(owed)
            .ok_or(StakeError::MathOverflow)?;

        // the burn IS the stake
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    from: ctx.accounts.staker_tokens.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        pos.weight = pos.weight.checked_add(amount).ok_or(StakeError::MathOverflow)?;
        pool.total_weight = pool
            .total_weight
            .checked_add(amount)
            .ok_or(StakeError::MathOverflow)?;
        // re-anchor debt at the new weight
        pos.debt = (pos.weight as u128)
            .checked_mul(pool.acc_per_weight)
            .ok_or(StakeError::MathOverflow)?
            / PRECISION;

        emit!(Staked { pool: pool.key(), asset: pos.asset, amount, new_weight: pos.weight });
        Ok(())
    }

    /// Pay out everything the asset has accrued, to its CURRENT owner.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        verify_core_asset(
            &ctx.accounts.asset,
            &ctx.accounts.pool.collection,
            &ctx.accounts.owner.key(),
        )?;

        let pool = &mut ctx.accounts.pool;
        let pos = &mut ctx.accounts.position;
        let owed = settle(pool, pos)?
            .checked_add(pos.pending_credit)
            .ok_or(StakeError::MathOverflow)?;
        pos.pending_credit = 0;
        require!(owed > 0, StakeError::NothingToClaim);

        // vault pays; the pool PDA signs
        let seeds: &[&[u8]] = &[
            b"pool",
            pool.token_mint.as_ref(),
            pool.collection.as_ref(),
            &[pool.bump],
        ];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[seeds],
            ),
            owed,
            ctx.accounts.reward_mint.decimals,
        )?;
        // the vault shrank by a paid claim, not a deposit — keep the delta
        // detector honest
        pool.vault_last = pool.vault_last.saturating_sub(owed);

        emit!(Claimed { pool: pool.key(), asset: pos.asset, amount: owed });
        Ok(())
    }
}

/// owed since last settle; debt is re-anchored by the caller after any
/// weight change.
fn settle(pool: &Account<RewardPool>, pos: &mut Position) -> Result<u64> {
    let entitled = (pos.weight as u128)
        .checked_mul(pool.acc_per_weight)
        .ok_or(StakeError::MathOverflow)?
        / PRECISION;
    let owed = entitled.checked_sub(pos.debt).ok_or(StakeError::MathOverflow)?;
    pos.debt = entitled;
    Ok(u64::try_from(owed).map_err(|_| StakeError::MathOverflow)?)
}

/// The asset must be a Metaplex Core asset, inside the pool's collection,
/// currently owned by `expected_owner`.
///
/// AUDIT: this deserializes the Core account layout directly (discriminator,
/// owner, update authority = collection for grouped assets). Pin the exact
/// mpl-core version and byte offsets, and cover: burned assets, frozen
/// assets, plugin-delegated authority, and assets regrouped to another
/// collection after staking.
fn verify_core_asset(
    asset: &AccountInfo,
    collection: &Pubkey,
    expected_owner: &Pubkey,
) -> Result<()> {
    let data = asset.try_borrow_data()?;
    // mpl-core AssetV1: [0]=Key::AssetV1(1), [1..33]=owner,
    // [33]=UpdateAuthority tag (2 = Collection), [34..66]=collection
    require!(data.len() >= 66 && data[0] == 1, StakeError::NotACoreAsset);
    let owner = Pubkey::try_from(&data[1..33]).unwrap();
    require!(&owner == expected_owner, StakeError::NotAssetOwner);
    require!(data[33] == 2, StakeError::NotInCollection);
    let grp = Pubkey::try_from(&data[34..66]).unwrap();
    require!(&grp == collection, StakeError::NotInCollection);
    Ok(())
}

// ---------------- accounts ----------------

#[account]
pub struct RewardPool {
    pub token_mint: Pubkey,    // the paired token that gets burned
    pub collection: Pubkey,    // the Core collection whose assets stake
    pub reward_mint: Pubkey,   // what claims pay out in
    pub vault: Pubkey,         // token account owned by this PDA
    pub total_weight: u64,
    pub acc_per_weight: u128,  // scaled by PRECISION
    pub vault_last: u64,       // vault balance at last sync/claim
    pub bump: u8,
}
impl RewardPool {
    pub const SIZE: usize = 8 + 32 * 4 + 8 + 16 + 8 + 1;
}

#[account]
pub struct Position {
    pub asset: Pubkey,         // the Core asset this tier belongs to
    pub weight: u64,           // total ever burned for this asset
    pub debt: u128,            // accumulator checkpoint
    pub pending_credit: u64,   // settled-but-unpaid (from stake-time settles)
    pub bump: u8,
}
impl Position {
    pub const SIZE: usize = 8 + 32 + 8 + 16 + 8 + 1;
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(
        init,
        payer = payer,
        space = RewardPool::SIZE,
        seeds = [b"pool", token_mint.key().as_ref(), collection.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, RewardPool>,
    pub token_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: the Core collection account; only its address seeds the pool
    pub collection: AccountInfo<'info>,
    pub reward_mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = reward_mint, token::authority = pool)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sync<'info> {
    #[account(mut, has_one = vault)]
    pub pool: Account<'info, RewardPool>,
    pub vault: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut, has_one = token_mint)]
    pub pool: Account<'info, RewardPool>,
    #[account(
        init_if_needed,
        payer = owner,
        space = Position::SIZE,
        seeds = [b"pos", asset.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    /// CHECK: verified byte-level in verify_core_asset
    pub asset: AccountInfo<'info>,
    #[account(mut)]
    pub token_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = token_mint, token::authority = owner)]
    pub staker_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, has_one = vault, has_one = reward_mint)]
    pub pool: Account<'info, RewardPool>,
    #[account(mut, seeds = [b"pos", asset.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
    /// CHECK: verified byte-level in verify_core_asset
    pub asset: AccountInfo<'info>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub reward_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = reward_mint)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub owner: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ---------------- events & errors ----------------

#[event]
pub struct Staked {
    pub pool: Pubkey,
    pub asset: Pubkey,
    pub amount: u64,
    pub new_weight: u64,
}

#[event]
pub struct Claimed {
    pub pool: Pubkey,
    pub asset: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Synced {
    pub pool: Pubkey,
    pub deposited: u64,
}

#[error_code]
pub enum StakeError {
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("account is not a Metaplex Core asset")]
    NotACoreAsset,
    #[msg("signer does not own this asset")]
    NotAssetOwner,
    #[msg("asset is not in this pool's collection")]
    NotInCollection,
}
