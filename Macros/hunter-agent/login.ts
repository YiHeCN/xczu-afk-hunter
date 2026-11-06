import { LOGIN_SPAWN, MAIN_SPAWN, authLoginCommand } from "./config.ts";

type Spawn = { x: number; y: number; z: number };

export function plainText(text: string): string {
  return text.replace(/§./g, "");
}

function worldSpawn(): Spawn | null {
  try {
    const pos = World.getRespawnPos();
    if (!pos) return null;
    return { x: pos.getX(), y: pos.getY(), z: pos.getZ() };
  } catch {
    return null;
  }
}

function sameSpawn(spawn: Spawn, expected: Spawn): boolean {
  return spawn.x === expected.x && spawn.y === expected.y && spawn.z === expected.z;
}

function tabLabel(): string {
  const player = Player.getPlayer();
  if (!player) return "";
  const entry = World.getPlayerEntry(player.getPlayerName());
  if (!entry) return "";
  const team = entry.getTeam();
  const prefix = team?.getPrefix()?.getString() ?? "";
  const suffix = team?.getSuffix()?.getString() ?? "";
  const display = entry.getDisplayText()?.getString() ?? "";
  return plainText(`${prefix}${display}${suffix}`);
}

/** 供测试时看当前是怎么判断登录服的。 */
export function serverStatus(): string {
  const spawn = worldSpawn();
  const spawnText = spawn ? `${spawn.x}, ${spawn.y}, ${spawn.z}` : "无";
  const tab = tabLabel() || "无";
  const where = isInLoginServer() ? "登录服" : "主服";
  return `${where}，出生点 [${spawnText}]，Tab ${tab}`;
}

/** 世界出生点是登录服，或 Tab 前缀写着登录服。 */
export function isInLoginServer(): boolean {
  const spawn = worldSpawn();
  if (spawn && sameSpawn(spawn, LOGIN_SPAWN)) return true;
  return tabLabel().includes("登录服");
}

/** 出生点是主服，并且 Tab 不是登录服。读不到出生点时不当作主服。 */
export function isOnMainServer(): boolean {
  const spawn = worldSpawn();
  if (!spawn || !sameSpawn(spawn, MAIN_SPAWN)) return false;
  return !tabLabel().includes("登录服");
}

export function isLoginSuccess(text: string): boolean {
  const plain = plainText(text);
  return plain.includes("已成功登录") || plain.includes("自动登录");
}

export function isSelfJoin(text: string): boolean {
  const name = Player.getPlayer()?.getPlayerName();
  if (!name) return false;
  const plain = plainText(text);
  return plain.includes(name) && plain.includes("加入了游戏");
}

/** 聊天是在要求输入 /login，而不是登录成功或自己发出的指令。 */
export function isAuthLoginPrompt(text: string): boolean {
  const plain = plainText(text);
  if (!plain || isLoginSuccess(plain)) return false;
  const password = authLoginCommand().split(" ")[1] ?? "";
  if (plain.trim().startsWith("/login") || (password !== "" && plain.includes(password)))
    return false;
  return plain.includes("/login") || plain.includes("请登录") || plain.includes("请输入密码");
}

/** 服务器说 home 还要冷却时，返回新的可发送时间。没有这句话则返回 null。 */
export function nextHomeReadyAt(text: string, currentReadyAt: number): number | null {
  const match = plainText(text).match(/该指令 home\s*需要冷却\s*(\d+)/);
  if (!match) return null;
  const ready = Date.now() + Number(match[1]) * 1000 + 200;
  return Math.max(currentReadyAt, ready);
}
