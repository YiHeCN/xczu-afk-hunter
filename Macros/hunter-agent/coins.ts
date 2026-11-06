import { log, offerLimitedCommand, type HunterContext } from "./actions.ts";
import { MONEY_COMMAND, MONEY_POLL_MS } from "./config.ts";
import { plainText } from "./login.ts";

const MONEY_WAIT_MS = 8_000;

let nextPollAt = 0;
let awaitingUntil = 0;
let burst: string[] = [];
let announced = false;
let reportedMiss = false;

/** 队列有空档时发一次 /em money top。回复在接下来的聊天里解析。 */
export function requestMoney(now = Date.now()): void {
  if (now < awaitingUntil || now < nextPollAt) return;
  if (!offerLimitedCommand(MONEY_COMMAND)) return;
  awaitingUntil = now + MONEY_WAIT_MS;
  nextPollAt = now + MONEY_POLL_MS;
  burst = [];
}

export function noteMoneyChat(context: HunterContext, text: string): void {
  if (awaitingUntil === 0 || Date.now() > awaitingUntil) return;
  const plain = plainText(text).trim();
  if (!plain) return;
  if (burst.length < 8) burst.push(plain);
  const name = Player.getPlayer()?.getPlayerName();
  if (!name) return;
  const amount = moneyAmount(plain, name);
  if (amount == null) return;
  context.wallet = amount;
  if (context.baselineWallet == null) context.baselineWallet = amount;
  if (!announced) {
    announced = true;
    Chat.log(`[hunter] /em money top 余额 ${formatCoins(amount)}（${plain.slice(0, 80)}）`);
  }
  awaitingUntil = 0;
  burst = [];
}

export function finishMoneyWait(): void {
  if (awaitingUntil === 0 || Date.now() < awaitingUntil) return;
  awaitingUntil = 0;
  const sample = burst.join(" | ");
  burst = [];
  if (reportedMiss || announced) return;
  reportedMiss = true;
  Chat.log(`[hunter] /em money top 没有解析到自己的余额：${sample || "没有聊天"}`);
}

export function noteUpgradeSpend(context: HunterContext, text: string): void {
  const match = plainText(text).match(/花费了\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*精英币/);
  if (!match) return;
  const spent = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(spent)) return;
  context.spentOnUpgrades += spent;
  log(`升级消耗 ${formatCoins(spent)} 精英币，累计消耗 ${formatCoins(context.spentOnUpgrades)}`);
}

export function showCoinStatus(context: HunterContext, now = Date.now()): void {
  const line = coinStatus(context, now);
  if (line === shownStatus && now - lastShownAt < 3_000) return;
  lastShownAt = now;
  shownStatus = line;
  ensureStatusOverlay();
  statusLine?.setText(line);
}

export function clearCoinStatus(): void {
  try {
    statusOverlay?.unregister();
  } catch {
    // 上一次脚本留下的画面层可能已经卸过。
  }
  Hud.clearDraw2Ds();
  statusOverlay = null;
  statusLine = null;
  shownStatus = "";
  lastShownAt = 0;
}

function coinStatus(context: HunterContext, now: number): string {
  if (context.abandonQuest) return "没怪了，换任务";
  if (context.questTurnInReady) return "去交付任务";
  if (context.clearForQuest || context.questComplete) return "任务已完成，回家清包";
  const quest =
    context.questActive && context.questProgress >= 0 && context.questTotal > 0
      ? `任务 ${context.questProgress} / ${context.questTotal}  `
      : context.questActive
        ? "任务已接取  "
        : "";
  const wallet = context.wallet;
  const baseline = context.baselineWallet;
  if (wallet == null || baseline == null) return `${quest}精英币还没读到`;
  const gained = wallet - baseline + context.spentOnUpgrades;
  const minutes = (now - context.startedAt) / 60_000;
  const perMinute = minutes >= 0.25 ? gained / minutes : null;
  const cost = context.upgradeCost;
  const need = cost == null ? null : cost - wallet;
  const eta = perMinute != null && perMinute > 0 && need != null && need > 0 ? need / perMinute : null;
  const rate = perMinute == null ? "收益计算中" : `每分钟 ${formatCoins(perMinute)}`;
  const goal =
    cost == null
      ? "升级花费未读到"
      : need != null && need <= 0
        ? "可以升级"
        : eta == null
          ? "升级时间暂不能估计"
          : `升级还要 ${formatEta(eta)}`;
  return `${quest}收获 ${formatCoins(gained)}  ${rate}  ${goal}`;
}

let statusOverlay: ReturnType<typeof Hud.createDraw2D> | null = null;
let statusLine: { setText: (text: string) => unknown } | null = null;
let shownStatus = "";
let lastShownAt = 0;

function ensureStatusOverlay(): void {
  if (statusOverlay) return;
  const overlay = Hud.createDraw2D();
  overlay.setOnInit(
    JavaWrapper.methodToJava((screen: ReturnType<typeof Hud.createDraw2D>) => {
      const width = screen.getWidth();
      const height = screen.getHeight();
      const boxWidth = 420;
      const x = Math.max(8, Math.floor((width - boxWidth) / 2));
      const y = Math.max(8, height - 108);
      screen.addRect(x - 6, y - 4, x + boxWidth, y + 14, 0x111111, 180);
      statusLine = screen.addText(shownStatus, x, y, 0xffdd88, true);
    }),
  );
  overlay.register();
  statusOverlay = overlay;
}

function moneyAmount(text: string, name: string): number | null {
  for (const line of text.split(/\n/)) {
    const amount = moneyOnLine(line.trim(), name);
    if (amount != null) return amount;
  }
  return null;
}

function moneyOnLine(line: string, name: string): number | null {
  if (!hasWholeName(line, name)) return null;
  const ranked = /(?:^|\s)#?\d+\s*[.、):]/.test(line) || /^\s*\d+\s+/.test(line);
  const aboutBalance = /top|排行|富豪|余额|balance|money/i.test(line);
  if (!ranked && !aboutBalance) return null;
  const stripped = line.replace(name, " ");
  const source = stripped.replace(/,/g, "");
  const wan = [...source.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*万/g)].map((match) => Number(match[1]) * 10_000);
  const wanValues = wan.filter((value) => Number.isFinite(value));
  if (wanValues.length > 0) return wanValues[wanValues.length - 1];
  const numbers = [...source.matchAll(/[0-9]+(?:\.[0-9]+)?/g)]
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value));
  if (numbers.length === 0) return null;
  if (ranked && numbers.length < 2) return null;
  return numbers[numbers.length - 1];
}

function hasWholeName(line: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`).test(line);
}

export function amountIn(text: string): number | null {
  const source = text.replace(/,/g, "");
  const wan = [...source.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*万/g)].map((match) => Number(match[1]) * 10_000);
  const wanValues = wan.filter((value) => Number.isFinite(value));
  if (wanValues.length > 0) return wanValues[wanValues.length - 1];
  const plain = [...source.matchAll(/[0-9]+(?:\.[0-9]+)?/g)]
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value));
  if (plain.length === 0) return null;
  return plain[plain.length - 1];
}

export function formatCoins(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatEta(minutes: number): string {
  const total = Math.max(1, Math.round(minutes));
  if (total < 60) return `${total} 分钟`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}
