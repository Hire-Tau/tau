#!/bin/sh

# Terminate and reap a child without allowing cleanup to wait indefinitely.
# Normal exits and zombies are reaped; a process still resistant after KILL is
# abandoned so PID 1 can continue cleaning fixed runtime paths and exit.
stop_and_join() {
  pid=$1
  [ -z "$pid" ] && return
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    if [ ! -e "/proc/$pid/stat" ]; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    state=$(awk '{ print $3 }' "/proc/$pid/stat" 2>/dev/null || true)
    if [ "$state" = Z ]; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if [ ! -e "/proc/$pid/stat" ]; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    state=$(awk '{ print $3 }' "/proc/$pid/stat" 2>/dev/null || true)
    if [ "$state" = Z ]; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    sleep 0.1
  done
  return
}
