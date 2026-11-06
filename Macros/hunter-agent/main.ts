import { Scheduler } from "../util/scheduler.ts";
import {
  canDoFieldWork,
  claimHunter,
  closeContainer,
  createContext,
  flushCommands,
  hunterIsCurrent,
  isInventoryFull,
  log,
  noteCommandBan,
  noteServerJoin,
  playerMenuOpen,
  setAuthBlocksQueue,
  stopPathing,
  upgradePaused,
  type HunterContext,
} from "./actions.ts";
import { clearCoinStatus, finishMoneyWait, noteMoneyChat, noteUpgradeSpend, requestMoney, showCoinStatus } from "./coins.ts";
import {
  isAuthLoginPrompt,
  isInLoginServer,
  isLoginSuccess,
  isSelfJoin,
  nextHomeReadyAt,
  serverStatus,
} from "./login.ts";
import { AuthLoginTask } from "./tasks/auth-login.ts";
import { DepositTask, hasGoodsToClear } from "./tasks/deposit.ts";
import { HuntTask } from "./tasks/hunt.ts";
import { noteQuestChat, noteQuestStatus, QuestTask } from "./tasks/quest.ts";
import { ServerLoginTask } from "./tasks/server-login.ts";
import { SuicideTask } from "./tasks/suicide.ts";
import { UpgradeTask } from "./tasks/upgrade.ts";

const context = createContext();
const scheduler = new Scheduler(context);

scheduler
  .register(new AuthLoginTask())
  .register(new ServerLoginTask())
  .register(new SuicideTask())
  .register(new QuestTask())
  .register(new UpgradeTask())
  .register(new DepositTask())
  .register(new HuntTask());

let authInterrupt = false;
let questInterrupt: "" | "deposit" | "quest" = "";

const listener = JsMacros.on(
  "RecvMessage",
  JavaWrapper.methodToJava((event: Events.RecvMessage) => {
    const text = event.text?.getString() ?? "";
    if (noteCommandBan(text)) return;
    if (isSelfJoin(text)) noteServerJoin();
    const readyAt = nextHomeReadyAt(text, context.homeReadyAt);
    if (readyAt !== null) {
      context.homeReadyAt = readyAt;
      const seconds = Math.ceil((readyAt - Date.now()) / 1000);
      log(`服务器要求 home 冷却 ${seconds} 秒`);
    }
    noteMoneyChat(context, text);
    noteUpgradeSpend(context, text);
    noteQuestStatus(context, text);
    if (noteQuestChat(context, text)) {
      if (hasGoodsToClear() || isInventoryFull()) {
        context.clearForQuest = true;
        questInterrupt = "deposit";
      } else {
        context.questTurnInReady = true;
        questInterrupt = "quest";
      }
    }
    if (isLoginSuccess(text)) {
      context.needsAuthLogin = false;
      log("登录成功");
      return;
    }
    if (!isAuthLoginPrompt(text)) return;
    if (isInLoginServer()) return;
    context.needsAuthLogin = true;
    authInterrupt = true;
    log(`收到登录提示：${text}`);
  }),
);

const runId = claimHunter();

clearCoinStatus();
closeContainer();
log("自动打怪已启动");
log(serverStatus());
scheduler.start();

let lastTask = "";
let lastServer = "";
let sawPlayer = !!Player.getPlayer();

try {
  while (true) {
    if (!hunterIsCurrent(runId)) {
      log("已有新的一份脚本在跑，停止这一份");
      break;
    }
    const online = !!Player.getPlayer();
    if (online && !sawPlayer) noteServerJoin();
    sawPlayer = online;
    if (playerMenuOpen()) {
      KeyBind.keyBind("key.use", false);
      KeyBind.keyBind("key.forward", false);
      stopPathing();
      Client.waitTick();
      continue;
    }
    const server = serverStatus();
    if (server !== lastServer) {
      if (lastServer) log(server);
      lastServer = server;
    }
    if (isInLoginServer()) {
      context.needsAuthLogin = false;
      authInterrupt = false;
    }
    setAuthBlocksQueue(context.needsAuthLogin);
    if (authInterrupt) {
      authInterrupt = false;
      questInterrupt = "";
      log("中断当前任务，去登录");
      scheduler.hardInterrupt("auth-login", "server requested login");
    } else if (questInterrupt && canDoFieldWork(context)) {
      const target = questInterrupt;
      questInterrupt = "";
      log(target === "deposit" ? "任务已完成，中断去清包" : "任务已完成，中断去交付");
      scheduler.hardInterrupt(target, "quest complete");
    }

    if (canDoFieldWork(context) && !upgradePaused(context)) requestUpgrade(context);

    scheduler.tick();
    if (canDoFieldWork(context)) requestMoney();
    finishMoneyWait();
    if (canDoFieldWork(context)) showCoinStatus(context);
    const taskName = scheduler.current?.name ?? "空闲";
    if (taskName !== lastTask) {
      log(`任务 ${lastTask || "无"} -> ${taskName}`);
      lastTask = taskName;
    }
    flushCommands();
    Client.waitTick();
  }
} finally {
  log("脚本停止");
  closeContainer();
  clearCoinStatus();
  scheduler.stop();
  JsMacros.off(listener);
}

function requestUpgrade(context: HunterContext): void {
  if (upgradePaused(context)) return;
  if (Date.now() < context.upgradeHoldUntil) return;
  if (!context.upgradeKnown || context.upgradeCost == null || context.wallet == null) return;
  if (context.depositForUpgrade || context.upgradeReady) return;
  if (context.wallet < context.upgradeCost) return;
  if (hasGoodsToClear()) {
    context.depositForUpgrade = true;
    log(`余额 ${context.wallet} 已达到升级所需 ${context.upgradeCost}，先出售并存储`);
    return;
  }
  context.upgradeReady = true;
  log(`余额 ${context.wallet} 已达到升级所需 ${context.upgradeCost}，直接升级`);
}
