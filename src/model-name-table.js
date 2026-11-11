/**
 * 原厂车型名表（SYSP:0x5E42C，24 条）—— 2026-11-11 逆取导出。
 *
 * 证据链：
 *   `PorscheGetVehicleNameID @SYSP 模块 0x24DE4`：
 *     0x24E02 `ldr.w r9,[pc,#0x60]` → 字面量 0x0003961E；
 *     0x24E0A `add r9, pc`（PC=0x24E0E）→ **r9 = 0x5E42C**（.rodata，文件偏移=VA）；
 *     0x24E10 `cmp r4,#0x17` → 循环 24 次（0..23）；
 *     0x24E1C `add.w r0,r9,r4,lsl#2` + 0x24E28 `ldr r6,[r0,#4]` → 第 i 项 = u32@(0x5E42C+4+4i)；
 *     0x24E26/0x24E2C 用 0x1E 字节缓冲把该键解析成本地文本；
 *     0x24E32 `blx strcmp` —— **逐字节全等**，命中即返回该键（= vehicleId）。
 *
 * 表结构：u32 count=24 @0x5E42C，随后 24×u32 文本键。
 * 键空间：0xFF0000xx = 本模块文本；0x0030xxxx / 0x000003FB = 公共文本。
 * 文本按模块语言库（PORSCHE_CN.GGP）解码，编码 GBK。
 *
 * ★ 注意：这**不是**「24 键语言表」。它是自动搜索时把车上应答串（22 11 02 /
 *   22 11 01）与车型名做 strcmp 的白名单；条目序号/vehicleId 是原厂车型 id。
 *   旧文档把它当语言表，导致 `pickModelByName` 用「目录基名归一化」替代真实白名单。
 *
 * `catalog` 是本项目车型目录（data/models-catalog.json）的可选映射：
 *   只有**文本本身已唯一确定平台**的条目才给映射；通用条目（如 "Cayman"）留 null，
 *   由调用方按 VIN 候选 + 用户确认处理，绝不猜代际。
 */

/** @typedef {{key:number, vid:number, text:string, catalog:string[]|null}} ModelNameEntry */

/** 24 条，顺序 = 原厂表顺序（strcmp 首个命中即返回，顺序有语义）。 */
export const MODEL_NAME_TABLE = /** @type {ModelNameEntry[]} */ ([
  { key: 0xff000001, vid: 1, text: 'Carrera GT（CS1）', catalog: ['Carrera GT'] },
  { key: 0xff000002, vid: 2, text: '918 Spyder（918）', catalog: ['918 Spyder'] },
  { key: 0xff00000f, vid: 15, text: 'Macan（J1）', catalog: ['Macan'] },
  { key: 0xff000004, vid: 4, text: 'Cayman', catalog: null },
  { key: 0xff000005, vid: 5, text: 'Taycan（J1）', catalog: ['Taycan'] },
  { key: 0x00300152, vid: 23, text: '911（996）', catalog: ['911（996）'] },
  { key: 0xff000007, vid: 7, text: '911（997）', catalog: ['911（997）'] },
  { key: 0xff000008, vid: 8, text: '911（991）', catalog: ['911（991）'] },
  { key: 0xff000009, vid: 9, text: '911（992）', catalog: ['911（992）'] },
  { key: 0xff00000a, vid: 10, text: '911（964/993）', catalog: ['911（964/993）'] },
  { key: 0xff000010, vid: 16, text: 'Cayenne（9PA）', catalog: ['Cayenne-9PA（至2010年款止）'] },
  { key: 0xff00001d, vid: 29, text: 'Cayenne（92A）', catalog: ['Cayenne-92A（2011 - 2017）'] },
  { key: 0x000003fb, vid: 29, text: 'Cayenne（92A）', catalog: ['Cayenne-92A（2011 - 2017）'] },
  { key: 0xff000012, vid: 18, text: 'Panamera（970）', catalog: ['Panamera-970（至2016年款止）'] },
  { key: 0xff00000e, vid: 30, text: 'Panamera（971）', catalog: ['Panamera-971（2017-2024）'] },
  { key: 0xff00001e, vid: 19, text: 'Panamera（YA）', catalog: ['Panamera-YA（自2024年款起）'] },
  { key: 0xff000013, vid: 20, text: 'Boxster（986）', catalog: ['Boxster（986）'] },
  { key: 0xff000014, vid: 21, text: 'Boxster（987）', catalog: ['Boxster（987）'] },
  { key: 0xff000015, vid: 22, text: 'Boxster（981）', catalog: ['Boxster（981）'] },
  { key: 0xff000016, vid: 24, text: 'Boxster（982）', catalog: ['Boxster（982）'] },
  { key: 0xff000017, vid: 28, text: 'Cayman/Boxster（987）', catalog: ['Boxster（987）', 'Cayman（987）'] },
  { key: 0xff000018, vid: 31, text: 'Cayman/Boxster（981）', catalog: ['Boxster（981）', 'Cayman（981）'] },
  { key: 0xff00001c, vid: 25, text: 'Cayman（982）', catalog: ['Cayman（982）'] },
  { key: 0xff00001f, vid: 27, text: 'Cayman GT4 Clubsport（982）', catalog: ['Cayman GT4 Clubsport'] },
]);

/**
 * 应答串 → 原厂表条目（strcmp 全等，首个命中）。
 * 归一化只做「首尾空白 + 全角/半角括号统一」，不做大小写/分词/前缀等近似匹配。
 * @param {string} text
 * @returns {ModelNameEntry|null}
 */
export function matchModelNameExact(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const norm = (s) => String(s ?? '')
    .trim()
    .replace(/\(/g, '（')
    .replace(/\)/g, '）');
  const want = norm(t);
  for (const e of MODEL_NAME_TABLE) {
    if (norm(e.text) === want) return e;
  }
  return null;
}
