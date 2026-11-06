const BACK_SLOT = 1;
const MAX_LEVEL = 1000;
const SCAN_INTERVAL = 200;
const LEVEL_PATTERN = /需要\s*(\d+)\s*级经验/;
const LEVEL_PATTERN_LOOSE = /需要[\s\S]{0,80}?(\d+)[\s\S]{0,40}?级经验/;

function main() {
    let waitingKey = "";
    let idleKey = "";
    let closed = false;
    while (true) {
        const inv = researchInventory();
        if (!inv) {
            if (!closed) {
                closed = true;
                waitingKey = "";
                idleKey = "";
                Chat.log("研究界面已关闭，等待重新打开");
            }
            Time.sleep(SCAN_INTERVAL);
            continue;
        }
        closed = false;

        const pending = offersOnPage(inv).sort((a, b) => a.level - b.level);
        if (pending.length === 0) {
            waitingKey = "";
            const key = pageKey(inv);
            if (key !== idleKey) {
                idleKey = key;
                Chat.log("本页没有未解锁的研究，等待手动翻页");
            }
            Time.sleep(SCAN_INTERVAL);
            continue;
        }

        idleKey = "";
        const levelNow = playerLevel();
        const offer = pending.find((item) => levelNow >= item.level);
        if (!offer) {
            const next = pending[0];
            const key = offerKey(next);
            if (key !== waitingKey) {
                waitingKey = key;
                Chat.log(`槽位 ${next.slot} ${next.name} 需要 ${next.level} 级，当前 ${levelNow} 级，等待升级`);
            }
            Time.sleep(SCAN_INTERVAL);
            continue;
        }

        waitingKey = "";
        Chat.log(`经验 ${levelNow} >= ${offer.level}，点击槽位 ${offer.slot} 解锁 ${offer.name}`);
        inv.click(offer.slot, 0);
        Time.sleep(300);
        returnFromDetail();
    }
}

function researchInventory() {
    const inv = Player.openInventory();
    if (!inv || !inv.isContainer()) return null;
    if ((inv.getContainerTitle() ?? "").indexOf("粘液") === -1) return null;
    return inv;
}

function returnFromDetail() {
    const back = Player.openInventory();
    if (!back?.isContainer()) return;
    if ((back.getContainerTitle() ?? "").indexOf("粘液") !== -1) return;
    back.click(BACK_SLOT, 0);
    Time.sleep(300);
}

function playerLevel() {
    return Player.getPlayer()?.getXPLevel() ?? 0;
}

function offerKey(offer) {
    return `${offer.slot}:${offer.level}:${offer.name}`;
}

function pageKey(inv) {
    const parts = [];
    for (const slot of containerSlots(inv)) {
        const item = inv.getSlot(slot);
        if (!item || item.isEmpty()) continue;
        parts.push(`${slot}:${plain(item.getName()?.getString() ?? "")}`);
    }
    return parts.join("|");
}

function offersOnPage(inv) {
    const offers = [];
    for (const slot of containerSlots(inv)) {
        const item = inv.getSlot(slot);
        if (!item || item.isEmpty()) continue;
        const text = itemText(item);
        if (!isLocked(text)) continue;
        const level = matchLevel(text, LEVEL_PATTERN) ?? matchLevel(text, LEVEL_PATTERN_LOOSE);
        if (level == null || level > MAX_LEVEL) continue;
        offers.push({
            slot,
            level,
            name: plain(item.getName()?.getString() ?? "研究"),
        });
    }
    return offers;
}

function itemText(item) {
    const lore = toArray(item.getLore())
        .map((line) => plain(line.getString()))
        .join("\n");
    const nbt = item.getNBT()?.asString() ?? "";
    return `${lore}\n${plain(nbt)}`;
}

function isLocked(text) {
    if (text.indexOf("已解锁") !== -1 && text.indexOf("未解锁") === -1) return false;
    return text.indexOf("未解锁") !== -1 || LEVEL_PATTERN.test(text) || LEVEL_PATTERN_LOOSE.test(text);
}

function matchLevel(text, pattern) {
    const match = text.match(pattern);
    if (!match) return null;
    return Number(match[1]);
}

function containerSlots(inv) {
    const slots = toArray(inv.getSlots("container"));
    if (slots.length > 0) return slots;
    const total = Math.min(inv.getTotalSlots(), 54);
    const fallback = [];
    for (let slot = 0; slot < total; slot++) fallback.push(slot);
    return fallback;
}

function plain(text) {
    return text.replace(/§./g, "");
}

function toArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    const list = [];
    if (typeof value.size === "function") {
        const size = value.size();
        for (let i = 0; i < size; i++) list.push(value.get(i));
        return list;
    }
    const length = value.length ?? 0;
    for (let i = 0; i < length; i++) list.push(value[i]);
    return list;
}

main();
