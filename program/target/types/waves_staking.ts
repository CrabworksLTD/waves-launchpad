/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/waves_staking.json`.
 */
export type WavesStaking = {
  "address": "DEg14RMeTu1q3SA88aiyeA55E4nqe5ZF667XQdUftnNY",
  "metadata": {
    "name": "wavesStaking",
    "version": "0.1.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "claim",
      "docs": [
        "Pay out everything the asset has accrued, to its CURRENT owner."
      ],
      "discriminator": [
        62,
        198,
        214,
        193,
        213,
        159,
        108,
        210
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "asset"
              }
            ]
          }
        },
        {
          "name": "asset"
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "rewardMint",
          "relations": [
            "pool"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "initPool",
      "docs": [
        "One pool per pair. Permissionless: the pool's identity IS the",
        "(token_mint, collection) pair, so a second init of the same pair",
        "fails on the PDA. The reward vault is a token account owned by the",
        "pool PDA — the keeper (or anyone) deposits into it; nothing else",
        "about the pool trusts the caller."
      ],
      "discriminator": [
        116,
        233,
        199,
        204,
        115,
        159,
        171,
        36
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "tokenMint"
              },
              {
                "kind": "account",
                "path": "collection"
              }
            ]
          }
        },
        {
          "name": "tokenMint"
        },
        {
          "name": "collection"
        },
        {
          "name": "rewardMint"
        },
        {
          "name": "vault"
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "stake",
      "docs": [
        "Burn `amount` of the paired token; the asset's weight rises by the",
        "same amount, permanently. The signer must currently own the asset."
      ],
      "discriminator": [
        206,
        176,
        202,
        18,
        200,
        209,
        179,
        108
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "asset"
              }
            ]
          }
        },
        {
          "name": "asset"
        },
        {
          "name": "tokenMint",
          "writable": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "stakerTokens",
          "writable": true
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "sync",
      "docs": [
        "Pull any new vault balance into the accumulator. Permissionless —",
        "the keeper calls it after depositing, but anyone may. Deposits made",
        "while total_weight == 0 sit in the vault until the first staker",
        "syncs afterwards (they roll forward rather than being lost)."
      ],
      "discriminator": [
        4,
        219,
        40,
        164,
        21,
        157,
        189,
        88
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "vault",
          "relations": [
            "pool"
          ]
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    },
    {
      "name": "rewardPool",
      "discriminator": [
        134,
        121,
        197,
        211,
        133,
        154,
        82,
        32
      ]
    }
  ],
  "events": [
    {
      "name": "claimed",
      "discriminator": [
        217,
        192,
        123,
        72,
        108,
        150,
        248,
        33
      ]
    },
    {
      "name": "staked",
      "discriminator": [
        11,
        146,
        45,
        205,
        230,
        58,
        213,
        240
      ]
    },
    {
      "name": "synced",
      "discriminator": [
        114,
        244,
        163,
        97,
        99,
        80,
        164,
        70
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "zeroAmount",
      "msg": "amount must be greater than zero"
    },
    {
      "code": 6001,
      "name": "nothingToClaim",
      "msg": "nothing to claim"
    },
    {
      "code": 6002,
      "name": "mathOverflow",
      "msg": "math overflow"
    },
    {
      "code": 6003,
      "name": "notACoreAsset",
      "msg": "account is not a Metaplex Core asset"
    },
    {
      "code": 6004,
      "name": "notAssetOwner",
      "msg": "signer does not own this asset"
    },
    {
      "code": 6005,
      "name": "notInCollection",
      "msg": "asset is not in this pool's collection"
    }
  ],
  "types": [
    {
      "name": "claimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "asset",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "position",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "asset",
            "type": "pubkey"
          },
          {
            "name": "weight",
            "type": "u64"
          },
          {
            "name": "debt",
            "type": "u128"
          },
          {
            "name": "pendingCredit",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "rewardPool",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "collection",
            "type": "pubkey"
          },
          {
            "name": "rewardMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "totalWeight",
            "type": "u64"
          },
          {
            "name": "accPerWeight",
            "type": "u128"
          },
          {
            "name": "vaultLast",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "staked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "asset",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "newWeight",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "synced",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "deposited",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
