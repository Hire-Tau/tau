/**
 * Deterministic vm-box naming + home-layout derivation, and the systemd-unit
 * control seam derived from the same sandboxId.
 *
 * Pure leaf module (crypto only, no db/network imports) so that BOTH
 * box-manager (provisioning) and services/sandbox/workspace-layout (agent
 * path resolution) can derive a box's unix user / HOME without importing each
 * other — a box's paths are fully derivable from its sandboxId alone, no live
 * box or db row required. {@link boxUnitControl} lives here for the same
 * reason: box-migrate and the platform's box-control ops script need the box's
 * unit commands without pulling in box-manager's db/ssh surface.
 */

import { createHash } from 'crypto'

/** The single source of truth for a box's unix user: `box_<first 12 hex of
 *  sha256(sandboxId)>`. Must match box-provision.sh's removal guard. */
export function boxUnixUser(sandboxId: string): string {
  const hash = createHash('sha256').update(sandboxId).digest('hex').slice(0, 12)
  return `box_${hash}`
}

/** A box user's HOME (Ubuntu `useradd --create-home` default). */
export function boxHomeForUser(unixUser: string): string {
  return `/home/${unixUser}`
}

/** A box's HOME derived straight from its sandboxId. */
export function boxHome(sandboxId: string): string {
  return boxHomeForUser(boxUnixUser(sandboxId))
}

/**
 * WHICH systemd manager runs a box's sandbox-server.
 *
 * - `system` — one root-owned unit per box under /etc/systemd/system
 *   (`tau-box-<user>.service`, `User=`/`Group=<user>`, its own
 *   `tau-box-<user>.slice`). No linger, so the box costs no `systemd --user`
 *   manager + dbus pair.
 * - `user` — the historical layout: `tau-sandbox-server.service` inside the box
 *   user's own lingering user manager. Required by rootless docker, whose
 *   daemon IS a user service on /run/user/<uid>/docker.sock.
 */
export type BoxUnitMode = 'system' | 'user'

/**
 * The sandboxId PREFIX decides the unit mode, exactly as it decides the role
 * (#1315: "the prefix is authoritative"). `agent_*` boxes are light — they
 * never run containers (`roleWantsDocker` is false) — so they get the system
 * unit; `squad_*` / `system_manager_*` boxes keep the user manager their
 * rootless dockerd requires.
 *
 * An unknown prefix keeps the USER layout rather than falling through to the
 * agent default: role-wise an unknown id counts as an agent, but moving a live
 * legacy box onto a different unit is a change with teeth, and box-provision.sh
 * derives the same conservative default from the same prefix.
 */
export function boxUnitMode(sandboxId: string): BoxUnitMode {
  return sandboxId.startsWith('agent_') ? 'system' : 'user'
}

/** The unit + the command prefixes that drive it. See {@link boxUnitControl}. */
export interface BoxUnitControl {
  mode: BoxUnitMode
  /** The SERVER unit — what `restart` targets, and what may be `inactive` on a
   *  perfectly healthy socket-activated box. */
  unit: string
  /** The socket unit that owns the box's 127.0.0.1:<port>. Always-on. */
  socket: string
  /** The systemd-socket-proxyd unit the socket activates. */
  proxy: string
  /** socket, proxy and server, space-joined in the order a teardown must stop
   *  them — the socket FIRST, or it re-activates the proxy mid-stop. */
  allUnits: string
  /** Full systemctl command prefix INCLUDING sudo: `${systemctl} restart ${unit}`. */
  systemctl: string
  /** Full journalctl command through `-u <unit>`; callers append their own
   *  `-n <lines> --no-pager` and redirection. */
  journalctl: string
  /** The SERVER unit's `is-active` probe, as one complete command. */
  isActiveCommand: () => string
  /** The SOCKET unit's `is-active` probe. An active socket is the box's real
   *  liveness signal: it means the port is held and the chain can wake. */
  socketIsActiveCommand: () => string
  /**
   * A probe for the PRE-SOCKET layout of a box this deploy has not
   * re-provisioned yet, or `undefined` when {@link isActiveCommand} already
   * covers it. Only system-mode boxes need one: an `agent_*` box that has not
   * been re-provisioned since S2 still runs `tau-sandbox-server.service` inside
   * its own user manager, which no system-mode probe would ever see — and
   * calling that box `exited` would condemn a perfectly live box.
   */
  legacyIsActiveCommand?: () => string
}

/**
 * The ONE seam every systemctl/journalctl string this codebase builds for a box
 * goes through, so the manager and box-provision.sh can never disagree about
 * which unit exists (the script is also passed `--unit-mode` explicitly, derived
 * from {@link boxUnitMode}).
 *
 * User-mode output is byte-identical to the pre-density commands, including the
 * split between the two shapes systemd offers for reaching another user's
 * manager: `--machine=<user>@.host --user` for control verbs (needs a running
 * per-user manager, which linger guarantees) and a `sudo -u <user> env
 * XDG_RUNTIME_DIR=…` drop for the read-only probes.
 *
 * CONTRACT: the user-mode `journalctl` / `isActiveCommand()` strings reference
 * a `$uid` REMOTE shell variable, which the calling command must define first
 * (`uid=$(id -u <user>)`) — as box-manager's machine snapshot does. System mode
 * needs no such variable.
 */
export function boxUnitControl(input: { sandboxId: string; unixUser: string }): BoxUnitControl {
  const { unixUser } = input
  const mode = boxUnitMode(input.sandboxId)
  const asBoxUser = `sudo -u ${shellQuoteBoxPath(unixUser)} env XDG_RUNTIME_DIR=/run/user/$uid`
  const legacyUserUnit = 'tau-sandbox-server.service'
  if (mode === 'system') {
    const prefix = `tau-box-${unixUser}`
    const unit = `${prefix}.service`
    const socket = `${prefix}.socket`
    const proxy = `${prefix}-proxy.service`
    return {
      mode,
      unit,
      socket,
      proxy,
      allUnits: `${socket} ${proxy} ${unit}`,
      systemctl: 'sudo systemctl',
      journalctl: `sudo journalctl -u ${unit}`,
      isActiveCommand: () => `sudo systemctl is-active ${unit}`,
      socketIsActiveCommand: () => `sudo systemctl is-active ${socket}`,
      legacyIsActiveCommand: () => `${asBoxUser} systemctl --user is-active ${legacyUserUnit}`,
    }
  }
  const unit = legacyUserUnit
  const socket = 'tau-sandbox-server.socket'
  const proxy = 'tau-sandbox-server-proxy.service'
  return {
    mode,
    unit,
    socket,
    proxy,
    allUnits: `${socket} ${proxy} ${unit}`,
    systemctl: `sudo systemctl --machine=${unixUser}@.host --user`,
    journalctl: `${asBoxUser} journalctl --user -u ${unit}`,
    isActiveCommand: () => `${asBoxUser} systemctl --user is-active ${unit}`,
    socketIsActiveCommand: () => `${asBoxUser} systemctl --user is-active ${socket}`,
    // A user-mode box's pre-socket layout used the SAME service unit name, so
    // `isActiveCommand()` already is the legacy probe.
    legacyIsActiveCommand: undefined,
  }
}

/** Single-quote a value for safe interpolation into a remote shell command
 *  (same shape as box-manager's local helper, kept here so this stays a leaf). */
function shellQuoteBoxPath(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
