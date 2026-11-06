import {
  ARRIVE_TIMEOUT_MS,
  COMMAND_BAN_HOLD_MS,
  COMMAND_GAP_MS,
  JOIN_SETTLE_MS,
  debugCommand,
  debugLog,
  HOME_COOLDOWN_MS,
  LOW_FOOD,
  LOW_HEALTH,
  TELEPORT_DISTANCE,
} from "./config.ts";
import { isInLoginServer, plainText } from "./login.ts";

export type Vec3 = { x: number; y: number; z: number };

export type HunterContext = {
  needsAuthLogin: boolean;
  homeReadyAt: number;
  startedAt: number;
  /** 脚本开始时第一次读到的精英币。 */
  baselineWallet: number | null;
  /** 本次 /ag 升级已经花掉的精英币，收获要加回去。 */
  spentOnUpgrades: number;
  /** 最近一次 /em money top 读到的精英币。 */
  wallet: number | null;
  /** 下一次升级需要的精英币。还没从面板读到时是 null。 */
  upgradeCost: number | null;
  upgradeKnown: boolean;
  /** 记分板够升级了，先走出售和存储。 */
  depositForUpgrade: boolean;
  /** 出售和存储已经结束，可以打开 /ag 点升级。 */
  upgradeReady: boolean;
  /** 升级面板没点成时，这段时间里不要反复回家。 */
  upgradeHoldUntil: number;
  /** 已经接了任务。进行中也可以升级，交接时再让路。 */
  questActive: boolean;
  /** 聊天进度已经打满，等清包或交付。 */
  questComplete: boolean;
  /** 先回家把包清空，不然任务奖励领不到。 */
  clearForQuest: boolean;
  /** 包已经空出来，可以去交付。 */
  questTurnInReady: boolean;
  /** 最近一次聊天里的任务进度。还没看到时是 -1。 */
  questProgress: number;
  questTotal: number;
  /** 这次接取之后有没有看到过未完成的进度。用来躲开交付前的旧消息。 */
  questSawPartial: boolean;
  /** 刚接取的这段时间里，不把旧的完成消息当成新任务。 */
  questIgnoreUntil: number;
  /** 本次脚本里最近一次接取成功的时间。0 表示还没接过。 */
  questAcceptedAt: number;
  /** 聊天里出现「你已接受任务」的时间。用来停掉重复接取。 */
  questAcceptSeenAt: number;
  logger: {
    error: (message: string) => void;
  };
};

export function log(message: string): void {
  if (!debugLog) return;
  Chat.log(`[hunter] ${message}`);
}

let pendingCommand: string | null = null;
/** 登录还没发完时，先把 /home 这类命令放在这里。 */
let parkedCommand: string | null = null;
let lastSentAt = 0;
let flushedCommand: string | null = null;
let deferredCommand = "";
let authBlocksQueue = false;

const OWNER_KEY = "hunter.owner";
const SENT_AT_KEY = "hunter.sentAt";
const SENT_CMD_KEY = "hunter.sentCmd";
const HOLD_KEY = "hunter.holdUntil";
const JOIN_KEY = "hunter.joinReadyAt";

/** 多份脚本共用一份记录，避免同时各发一条命令。 */
function sentAt(): number {
  return GlobalVars.getDouble(SENT_AT_KEY) ?? 0;
}

function holdUntil(): number {
  return GlobalVars.getDouble(HOLD_KEY) ?? 0;
}

function sentCommand(): string {
  return GlobalVars.getString(SENT_CMD_KEY) ?? "";
}

export function claimHunter(): number {
  const next = (GlobalVars.getInt(OWNER_KEY) ?? 0) + 1;
  GlobalVars.putInt(OWNER_KEY, next);
  return next;
}

export function hunterIsCurrent(id: number): boolean {
  return GlobalVars.getInt(OWNER_KEY) === id;
}

function joinReadyAt(): number {
  return GlobalVars.getDouble(JOIN_KEY) ?? 0;
}

/** 聊天里看到自己进服，或玩家实体重新出现时调用。 */
export function noteServerJoin(): void {
  const now = Date.now();
  if (joinReadyAt() - now > 1_000) return;
  GlobalVars.putDouble(JOIN_KEY, now + JOIN_SETTLE_MS);
  traceCommand("进服等待", `${JOIN_SETTLE_MS / 1000} 秒`);
}

export function setAuthBlocksQueue(blocked: boolean): void {
  authBlocksQueue = blocked;
}

function commandReady(now = Date.now()): boolean {
  return now >= holdUntil() && now - sentAt() >= COMMAND_GAP_MS;
}

function othersMustWait(command: string, now = Date.now()): boolean {
  if (isLoginCommand(command)) return false;
  return authBlocksQueue || now < joinReadyAt();
}

function isRecentHome(command: string, now = Date.now()): boolean {
  return command.startsWith("/home ") && sentCommand() === command && now - sentAt() < HOME_COOLDOWN_MS;
}

function traceCommand(action: string, command: string, withGap = false): void {
  if (!debugCommand) return;
  const previous = Math.max(lastSentAt, sentAt());
  const gap = withGap && previous > 0 ? ` +${Date.now() - previous}ms` : "";
  Chat.log(`[hunter:cmd] ${action}${gap} ${command}`);
}

function isLoginCommand(command: string): boolean {
  return command === "/login" || command.startsWith("/login ");
}

const LIMITED_COMMANDS = ["/home", "/login", "/suicide", "/ag", "/em"];

function isLimitedCommand(command: string): boolean {
  return LIMITED_COMMANDS.some((prefix) => command === prefix || command.startsWith(`${prefix} `));
}

/** `#goto`、`#stop` 只给本地 Baritone，立刻发。斜杠命令排队，避免踢出。 */
export function sayCommand(command: string): void {
  if (!isLimitedCommand(command)) {
    traceCommand("发出", command, true);
    lastSentAt = Date.now();
    Chat.say(command);
    return;
  }
  if (isLoginCommand(command)) {
    if (pendingCommand && !isLoginCommand(pendingCommand)) parkedCommand = pendingCommand;
    if (pendingCommand !== command) traceCommand("排队", command);
    pendingCommand = command;
    return;
  }
  if (pendingCommand && isLoginCommand(pendingCommand)) {
    if (parkedCommand !== command) traceCommand("登录优先，延后", command);
    parkedCommand = command;
    return;
  }
  if (pendingCommand !== command) traceCommand("排队", command);
  pendingCommand = command;
}

/** 队列空着、而且现在就能发时才排队。给余额查询用，不挤掉 /home。 */
export function offerLimitedCommand(command: string): boolean {
  if (pendingCommand || parkedCommand) return false;
  const now = Date.now();
  if (othersMustWait(command, now) || !commandReady(now)) return false;
  sayCommand(command);
  return true;
}

export function consumeSentCommand(): string | null {
  const sent = flushedCommand;
  flushedCommand = null;
  return sent;
}

export function noteCommandBan(text: string): boolean {
  if (!text.includes("发送命令的速度太快")) return false;
  GlobalVars.putDouble(HOLD_KEY, Date.now() + COMMAND_BAN_HOLD_MS);
  GlobalVars.putString(SENT_CMD_KEY, "");
  pendingCommand = null;
  parkedCommand = null;
  Chat.log(`[hunter:cmd] 命令过快被踢，暂停 ${COMMAND_BAN_HOLD_MS / 1000} 秒`);
  return true;
}

export function flushCommands(): void {
  if (!pendingCommand || !Player.getPlayer()) return;
  const now = Date.now();
  const command = pendingCommand;
  if (isRecentHome(command, now)) {
    pendingCommand = parkedCommand;
    parkedCommand = null;
    traceCommand("已发过，丢弃", command);
    return;
  }
  if (othersMustWait(command, now)) {
    if (deferredCommand !== command) {
      traceCommand(authBlocksQueue ? "等登录" : "进服等待", command);
      deferredCommand = command;
    }
    return;
  }
  if (!commandReady(now)) return;
  pendingCommand = null;
  traceCommand("发出", command, true);
  flushedCommand = command;
  lastSentAt = now;
  GlobalVars.putDouble(SENT_AT_KEY, now);
  GlobalVars.putString(SENT_CMD_KEY, command);
  Chat.say(command);
  if (parkedCommand) {
    pendingCommand = parkedCommand;
    parkedCommand = null;
  }
}

export function createContext(): HunterContext {
  return {
    needsAuthLogin: false,
    homeReadyAt: 0,
    startedAt: Date.now(),
    baselineWallet: null,
    spentOnUpgrades: 0,
    wallet: null,
    upgradeCost: null,
    upgradeKnown: false,
    depositForUpgrade: false,
    upgradeReady: false,
    upgradeHoldUntil: 0,
    questActive: false,
    questComplete: false,
    clearForQuest: false,
    questTurnInReady: false,
    questProgress: -1,
    questTotal: 0,
    questSawPartial: false,
    questIgnoreUntil: 0,
    questAcceptedAt: 0,
    questAcceptSeenAt: 0,
    logger: {
      error(message: string) {
        Chat.log(`[hunter] ${message}`);
      },
    },
  };
}

/** 任务交付和清包时先不升级。任务进行中钱够了就升。 */
export function upgradePaused(context: HunterContext): boolean {
  return context.questComplete || context.clearForQuest || context.questTurnInReady;
}

export function canDoFieldWork(context: HunterContext): boolean {
  const player = Player.getPlayer();
  return !context.needsAuthLogin && !isInLoginServer() && !!player && player.getHealth() > 0;
}

export function playerPosition(): Vec3 | null {
  const player = Player.getPlayer();
  if (!player) return null;
  return { x: player.getX(), y: player.getY(), z: player.getZ() };
}

export type TeleportProgress = "moving" | "arrived" | "missed";

/** 位置拉开才算传到。超时仍在原地则是没传成，调用方应重试。 */
export function teleportProgress(from: Vec3 | null, startedAt: number): TeleportProgress {
  const pos = playerPosition();
  if (pos && from && distance(pos, from) >= TELEPORT_DISTANCE) return "arrived";
  if (Date.now() - startedAt >= ARRIVE_TIMEOUT_MS) return "missed";
  return "moving";
}

export function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function needsSuicide(): boolean {
  const player = Player.getPlayer();
  if (!player || player.getHealth() <= 0) return false;
  return player.getHealth() < LOW_HEALTH || player.getFoodLevel() < LOW_FOOD;
}

export function toArray<T>(value: JavaList<T> | JavaArray<T> | null | undefined): T[] {
  if (!value) return [];
  if (Java.isJavaObject(value)) return Java.from(value as JavaList<T>);
  const array = value as ArrayLike<T>;
  const out: T[] = [];
  for (let index = 0; index < array.length; index += 1) out.push(array[index]);
  return out;
}

export function isInventoryFull(): boolean {
  const inv = Player.openInventory();
  if (!inv) return false;
  const slots = toArray(inv.getSlots("main", "hotbar"));
  if (slots.length === 0) return false;
  return slots.every((slot) => !inv.getSlot(slot).isEmpty());
}

let pathing = false;
let lastPathKey = "";
let lastPathAt = 0;
let steering = false;

/** 暂停菜单、设置这类界面留给玩家，脚本不去关。 */
export function playerMenuOpen(): boolean {
  const name = Hud.getOpenScreenName() ?? "";
  if (!name || name === "Survival Inventory") return false;
  try {
    return !Player.openInventory()?.isContainer();
  } catch {
    return false;
  }
}

export function closeContainer(): void {
  if (!Player.getPlayer() || playerMenuOpen()) return;
  try {
    const inv = Player.openInventory();
    if (!inv?.isContainer()) return;
    inv.close();
  } catch {
    // 进服或被踢时玩家实体还没准备好。
  }
}

export function hasLevitation(): boolean {
  return Player.getPlayer()?.hasStatusEffect("levitation") ?? false;
}

export function openContainer(): NonNullable<ReturnType<typeof Player.openInventory>> | null {
  try {
    const inv = Player.openInventory();
    if (!inv?.isContainer()) return null;
    return inv;
  } catch {
    return null;
  }
}

export function containerTitle(): string {
  return plainText(openContainer()?.getContainerTitle() ?? "");
}

export function selectHotbar(index: number): void {
  try {
    Player.openInventory()?.setSelectedHotbarSlotIndex(index);
  } catch {
    // 换世界时背包可能还没准备好。
  }
}

/** 飘浮时 Baritone 不会走，改为面向目标并按住前进。 */
export function steerToward(x: number, y: number, z: number): void {
  if (pathing) {
    sayCommand("#stop");
    pathing = false;
    lastPathKey = "";
  }
  Player.getPlayer()?.lookAt(x, y, z);
  KeyBind.keyBind("key.forward", true);
  steering = true;
}

export function stopSteering(): void {
  if (!steering) return;
  KeyBind.keyBind("key.forward", false);
  steering = false;
}

export function pathTo(x: number, y: number, z: number): void {
  stopSteering();
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const key = `${fx} ${fy} ${fz}`;
  const now = Date.now();
  if (pathing && lastPathKey) {
    const [lx, ly, lz] = lastPathKey.split(" ").map(Number);
    const moved = distance({ x: fx, y: fy, z: fz }, { x: lx, y: ly, z: lz });
    if (moved < 4 && now - lastPathAt < 3_000) return;
  }
  sayCommand(`#goto ${key}`);
  pathing = true;
  lastPathKey = key;
  lastPathAt = now;
}

export function stopPathing(): void {
  stopSteering();
  if (!pathing) return;
  sayCommand("#stop");
  pathing = false;
  lastPathKey = "";
}

let cooldownLoggedFor = "";

/**
 * 命令真正排进去才返回 true。
 * 冷却、进服等待或发送间隔没到时返回 false，避免人还没走就开始算到达。
 */
export function tryUseHome(context: HunterContext, home: string): boolean {
  const now = Date.now();
  const command = `/home ${home}`;
  if (now < context.homeReadyAt) {
    if (cooldownLoggedFor !== home) {
      const seconds = Math.ceil((context.homeReadyAt - now) / 1000);
      log(`/home ${home} 还要等 ${seconds} 秒`);
      cooldownLoggedFor = home;
    }
    return false;
  }
  if (isRecentHome(command, now)) {
    context.homeReadyAt = sentAt() + HOME_COOLDOWN_MS;
    return true;
  }
  if (othersMustWait(command, now) || !commandReady(now)) {
    if (deferredCommand !== command) {
      const waiting = othersMustWait(command, now);
      traceCommand(waiting ? (authBlocksQueue ? "等登录" : "进服等待") : "间隔", command);
      deferredCommand = command;
    }
    return false;
  }
  deferredCommand = "";
  cooldownLoggedFor = "";
  stopPathing();
  sayCommand(command);
  context.homeReadyAt = now + HOME_COOLDOWN_MS;
  log(`传送 /home ${home}`);
  return true;
}
