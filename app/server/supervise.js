#!/usr/bin/env node
"use strict";
// Keeps the builder server running.
//
// The server exits on any unexpected fault rather than limping on in an
// unknown state, which only helps if something starts it again. This is that
// something: a parent that respawns the child, with backoff so a server that
// cannot start at all does not spin the CPU.
//
//   npm start        supervised
//   npm run dev      bare, exits on fault — better while developing
//
// Deliberately dependency-free, like the rest of the project. For a real
// deployment a system supervisor (systemd, launchd) is a better fit; this
// exists so a crash on a laptop does not silently end the session.

const { spawn } = require("child_process");
const path = require("path");

const SERVER = path.join(__dirname, "server.js");
const MIN_BACKOFF = 500;
const MAX_BACKOFF = 30000;
// A process that ran this long is considered healthy, so its next crash starts
// from the shortest delay again instead of inheriting an old backoff.
const HEALTHY_AFTER = 60000;

let backoff = MIN_BACKOFF;
let stopping = false;
let child = null;

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [SERVER], { stdio: "inherit", env: process.env });

  child.on("exit", function (code, signal) {
    child = null;
    if (stopping) return;

    const ran = Date.now() - startedAt;
    if (ran >= HEALTHY_AFTER) backoff = MIN_BACKOFF;

    const why = signal ? "signal " + signal : "code " + code;
    console.error("[supervise] server exited (" + why + ") after " +
      (ran / 1000).toFixed(1) + "s — restarting in " + (backoff / 1000).toFixed(1) + "s");

    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  });

  child.on("error", function (err) {
    console.error("[supervise] could not spawn server:", err.message);
  });
}

// Ctrl-C should stop the whole thing, not just the child, or the supervisor
// would dutifully restart the server that was just stopped.
["SIGINT", "SIGTERM"].forEach(function (sig) {
  process.on(sig, function () {
    stopping = true;
    if (child) child.kill(sig);
    setTimeout(function () { process.exit(0); }, 3500).unref();
  });
});

console.log("[supervise] starting " + path.relative(process.cwd(), SERVER));
start();
