/** 关掉后不再往聊天写 [hunter] 日志。调试时改成 true。 */
export const debugLog = false;
/** 记录每条发出的命令，以及距上一条的间隔。 */
export const debugCommand = true;

export const TaskPriority = {
  authLogin: 100,
  serverLogin: 90,
  suicide: 80,
  quest: 75,
  upgrade: 70,
  deposit: 50,
  hunt: 10,
};

export const LOW_HEALTH = 10;
export const LOW_FOOD = 6;

/** 血量或饥饿低于阈值后执行。旧脚本用的是 /suicide。 */
export const suicideCommand = "/suicide";

/** 主服聊天要求登录时发送。登录服上不发。 */
export const authLoginCommand = "/login 123666";

export const HOME_COOLDOWN_MS = 10_000;
/** 两条斜杠命令至少隔这么久，避免被判定发送过快。 */
export const COMMAND_GAP_MS = 3_000;
/** 因命令过快被踢后，重进服务器先停这么久。 */
export const COMMAND_BAN_HOLD_MS = 20_000;
/** 进服后先等这么久，再发送队列里除 /login 以外的命令。 */
export const JOIN_SETTLE_MS = 6_000;
export const AUTH_HOLD_MS = 3_000;
export const ARRIVE_TIMEOUT_MS = 4_000;
export const TELEPORT_DISTANCE = 8;
/** 近到这个距离后改为按住前进，走到怪身上，方便荆棘反伤。 */
export const ENGAGE_DISTANCE = 3;
/** 玩家和怪物的 Y 轴差超过这个值就不追。另一层用另一个家。 */
export const MAX_MOB_Y_GAP = 2;
/** 寻路时坐标几乎不动超过这个时间，就换下一个家。 */
export const STUCK_MS = 30_000;
export const STUCK_DISTANCE = 2;
/** 落地后怪大约 3 秒才刷新，第一次采集放在这之后。 */
export const SURVEY_FIRST_MS = 4_000;
export const SUICIDE_RETRY_MS = 5_000;

/** 登录服出生点。主服出生点用来确认可以发送 /login。 */
export const LOGIN_SPAWN = { x: 17, y: -4, z: -47 };
export const MAIN_SPAWN = { x: 0, y: 64, z: 0 };

/** 进登录服后先等这么久，再右键主手菜单。 */
export const BAN_WAIT_MS = 40_000;
/** 菜单没打开或点完仍在登录服时，隔这么久再点一次。 */
export const LOGIN_RETRY_MS = 20_000;
/** 主手菜单里回到服务器的格子。 */
export const RETURN_SLOT = 20;

/** 背包满了之后传送回来的家。 */
export const baseHome = "1";

/** 直接打开任务 NPC 菜单，不必先 /home q 再右键。 */
export const QUEST_NPC_COMMAND = "/em quest npc RenWu.yml";
/** 任务列表界面标题。 */
export const QUEST_LIST_TITLE = "Quests";
/** 还没接的时候点这一格。第一格是 0。 */
export const QUEST_ACCEPT_SLOT = 10;
/** 接取之后，进行中的任务会挪到这一格，交付点这里。 */
export const QUEST_TURNIN_SLOT = 1;
/** 打开列表时这一格已经是该任务，就说明接过了，不要再点接取。 */
export const ACTIVE_QUEST_NAME = "北极的危机";
/** 进入任务详情后的确认格。接取和交付都点这里。 */
export const QUEST_CONFIRM_SLOT = 26;

export const SHOP_COMMAND = "/em shop dynamic";
export const AG_COMMAND = "/ag";
/** 记分板在任务期间没有精英币，改用这条命令读余额。 */
export const MONEY_COMMAND = "/em money top";
/** 两次查询至少隔这么久，避免占满命令间隔。 */
export const MONEY_POLL_MS = 20_000;
export const SHOP_CATEGORY_SLOT = 15;
export const SHOP_CONFIRM_SLOT = 35;
export const SELL_BATCH = 21;
/** 快捷栏 1（下标 0）是剑，右键会被技能取消。打开终端前先把快捷栏 2 移进背包，再空手点击。 */
export const SWORD_HOTBAR = 0;
export const TERMINAL_HOTBAR = 1;
export const TERMINAL_HOLD_MS = 1_000;
/** 回家后先等区块加载，再点 ME 终端。 */
export const TERMINAL_LOAD_MS = 5_000;
/** 终端打开后先等界面同步，再把物品存进去。 */
export const TERMINAL_SYNC_MS = 5_000;

/** 这些显示名留在身上，不卖也不存。 */
export const keepItemNames = ["· 始源之遗 ·", "无线终端"];

export type FarmSpot = {
  /** `/home` 的家名称 */
  home: string;
  /** 怪物显示名包含其中任意一段即视为目标 */
  targets: string[];
  /** 只追这个半径内的怪物 */
  searchRadius: number;
};

/**
 * 刷怪点列表。脚本会传送到当前点，找符合 targets 的怪物，
 * 再用 Baritone 走过去，近身后贴到怪身上吃荆棘反伤。
 */
export const homeList: FarmSpot[] = [
  { home: "p3", targets: [], searchRadius: 48 },
  { home: "bj1", targets: [], searchRadius: 48 },
  { home: "bj2", targets: [], searchRadius: 48 },
  { home: "bj3", targets: [], searchRadius: 48 },
];
