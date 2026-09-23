/**
 * 用电场景归集规则 —— 与原 sync_energy_to_sqlite.py 的 classify_meter 保持一致。
 * 按房间 / 安装点位名称关键词匹配，顺序敏感（如「花房-空调」优先命中「空调」）。
 */
export const CATEGORY_RULES: ReadonlyArray<readonly [string, string]> = [
  ['空调', '空调系统'],
  ['照明', '照明系统'],
  ['水泵', '给排水系统'],
  ['电梯', '电梯系统'],
  ['花房', '花房'],
  ['儿童', '儿童空间'],
  ['宠物', '宠物用房'],
  ['学习', '学习盒子'],
  ['日咖', '日咖夜酒'],
];

export function classifyMeter(roomName: string): string {
  const name = (roomName ?? '').toLowerCase();
  for (const [keyword, category] of CATEGORY_RULES) {
    if (name.includes(keyword)) return category;
  }
  return '其他负荷';
}

/** 所有可能的用电场景分类（含兜底） */
export const ALL_CATEGORIES: string[] = [
  ...CATEGORY_RULES.map(([, category]) => category),
  '其他负荷',
];
