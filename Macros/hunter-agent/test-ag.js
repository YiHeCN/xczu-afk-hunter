// 单独运行这一份，不要和自动打怪一起开。
// 它会记下侧边记分板，发送 /ag，再把面板每一格的名字和说明打到聊天里。

function plain(text) {
  return String(text ?? "").replace(/§./g, "");
}

function say(message) {
  Chat.log(`[ag-test] ${message}`);
}

function entries(map) {
  const out = [];
  if (!map) return out;
  const iterator = map.entrySet().iterator();
  while (iterator.hasNext()) {
    const entry = iterator.next();
    out.push([entry.getKey(), entry.getValue()]);
  }
  return out;
}

function toArray(value) {
  if (!value) return [];
  if (Java.isJavaObject(value)) return Java.from(value);
  return Array.from(value);
}

function dumpBoard() {
  const objective = World.getScoreboards()?.getCurrentScoreboard();
  if (!objective) {
    say("没有侧边记分板");
    return;
  }
  say(`记分板 ${plain(objective.getDisplayName()?.getString?.() ?? "")} / ${objective.getName()}`);
  for (const [score, text] of entries(objective.scoreToDisplayName())) {
    say(`显示 ${score} ${plain(text?.getString?.() ?? text)}`);
  }
  for (const [name, score] of entries(objective.getPlayerScores())) {
    say(`分数 ${plain(name)} ${score}`);
  }
}

function dumpPanel(inv) {
  say(`标题 ${plain(inv.getContainerTitle())}`);
  let slots = toArray(inv.getSlots("container"));
  if (slots.length === 0) {
    slots = [];
    for (let index = 0; index < inv.getTotalSlots(); index += 1) slots.push(index);
  }
  for (const slot of slots) {
    const item = inv.getSlot(slot);
    if (item.isEmpty()) continue;
    const name = plain(item.getName()?.getString() ?? "");
    const lore = toArray(item.getLore())
      .map((line) => plain(line.getString()))
      .join(" | ");
    say(`格子 ${slot}：${name}${lore ? ` || ${lore}` : ""}`);
  }
}

dumpBoard();
say("发送 /ag");
Chat.say("/ag");

let opened = false;
for (let tick = 0; tick < 80 && !opened; tick += 1) {
  Client.waitTick();
  const inv = Player.openInventory();
  if (!inv?.isContainer()) continue;
  dumpPanel(inv);
  inv.close();
  opened = true;
}

if (!opened) say("8 秒内没有打开面板");
say("记录结束");
