#!/usr/bin/env python3
"""执行器条目重建 v4：从 ALL_ACTINFO 命令块按 SID 分类，逐项取真实地址（u16 小端）。

═══ 记录布局（本次重建的**唯一**口径，逐条可复算）═══
名称记录：`[u16 名长][ASCII chain 串（$ 连接多段名键）\\0][命令块 N 字节]`
命令块（典型 11 字节，实测 39,043 条同构）：

    +0  变体标志      0x00 / 0x01（同族两种写法，与地址无关）
    +1  类别字节      0x2F 族→0x01 / 0x31 族→0x10 / 容器→0xFF
    +2  控制选项      0x2F：controlOption（实测恒 0x03）/ 0x31：sub-function
    +3  UDS SID       0x2F / 0x31 / 0x30 …
    +4  u16           恒 00 00
    +6  u16 **小端**  逐项地址：0x2F→DID，0x31→RID（★ 本版改动点）
    +8  u16           恒 00 00
    +10 尾字节        选择器/变体序号（≠ 参数载荷；无法解释，留 recordTail）

═══ 与 v3 的差异（每处都是已确证的解析错误）═══
1. `did = (blob[end] << 8) | blob[end + 1]` —— 把**类别字节 + 控制选项**当成 DID，
   于是 150 条 `2F` 只剩 2 个 DID（0x0101/0x01FF），全部条目的"逐项身份"被抹平。
   → 改为 `struct.unpack_from('<H', fld, 6)[0]`（命令块 +6，u16 LE）。
2. `if not (0x0100 <= did <= 0x0FFF): continue` —— 用假 DID 的值域当过滤器，
   把 629 条本来有记录的条目直接判成"无记录"。
   → 删除值域过滤，改为**按 SID 分类**：0x2F→io、0x31→routine、0x30→record（有地址无帧）、
     其余（0x00/0xF0/…）→ 目录项。
3. `struct.unpack_from('>H', fld, 4)`（RID 大端）—— 与服务同族的 2F 地址口径不一致。
   → 改 `'<H', fld, 6`（同一个 +6 u16 小端字段）。
4. 容器记录（`fld[1] == 0xFF`）被当成普通执行器 → 标 `container: true`，不产出可驱动条目。
5. 平台块（`block`）：ALL_ACTINFO 头部索引表 `[u8 id][u16 名长][名\\0][u32 指针]` 给出
   各平台块起点，`block = 指针 ≤ 记录偏移 的最后一个块`；同一 chain 名在不同块里是
   **不同模块**，所以去重键是 `(block, chain, sid)` 而不是 `chain`。
6. 地址可信度（`addrVerified`）：命名空间底线之下的地址需要 GAG 实测背书，
   否则标 false 并进 `source.unresolved`（宁可标未验证，也不假装已验证）。
7. 解析歧义只**报告**不**取舍**：
   * `didResolve` / `ridResolve` 是**结构标签**（single-address / multi-resolved-by-module /
     ambiguous-in-module / multi-address），多址另带 `multiAddressBasis`
     （**只有两个取值**：high-byte-differs / high-byte-same）。
     `high-byte-differs` 只描述"两个候选的高字节不同"这个数值事实，**不声称**分属不同功能域
     —— 实测高字节不是模块族（0x01 覆盖 120 个模块族），所以不用 `cross-family` 这种被否证的措辞。
   * 同一 chain 若还有一种 27 字节记录在 +6 给出**不同**地址，条目带
     `rawLayoutConflict: true` + `cmdRaw`（原始命令块）+ `rawLayoutCandidates`（两种形态并列），
     **取值一律不动**（哪个形态权威静态无法判定）。
     ★ 语义红线：`didCandidates`/`ridCandidates` = 「**规范 11 字节记录形态**下的候选地址」
     （同链多址＝多个 ECU 各有一份同名功能），`rawLayoutCandidates` = 「同一 chain 的**另一种
     记录形态**及其 +6 读数」，**后者不进入候选地址列表**。两种事实不可混标：27 字节块的值
     不是"另一个 ECU 的拷贝"，把它塞进候选列表会把两件事压成一个数字，也会破坏
     「2F 多址 13 + 31 多址 5 = 18 = 模块可拆 11 + 白名单不可解 7」这条恒等式。
     因此 `single-address` 与 `rawLayoutConflict: true` **可以并存**：前者说"规范形态下地址唯一"，
     后者说"库里另有一种形态读数不同"。
   * `paramsSrc` 六桶见 §8；`paramsResolved: 'multi'` / `'no-template'` 不等于"不需要参数"，
     未解决条数写进 `source.paramsUnresolved`。

═══ 不可变约束 ═══
* 条目集合 = `git show HEAD:data/actuator.json` 的 2506 条已验证项（只加字段，不增删）。
* 名称/chain 来自正本；本脚本**不发明** DID 分布、不白名单、不为了让门禁绿而修饰数据。
* 0x31 的 params 只取 GAG 实测例程库（`paramsSrc: 'gag-lib'`）；记录尾字节不是载荷，
  没有实测参数就留空（`paramsSrc: 'absent'`）——**不猜测参数**。
* 0x2F 的 controlOption/state：did 落在 GAG 实测集内 → `stateSrc: 'measured'`
  （state 取 observedStates，controlOption 取实测值）；否则 controlOption 取记录 +2
  （实测恒 0x03），state 用记录默认 `FF 00 00 00`（`stateSrc: 'default'`，明确标注是
  默认值而非实测）。只有这两个取值，没有第三个"假实测"标签。

═══ 输入解析（本脚本是**生成器**，不是门禁：没有输入就硬失败，绝不 SKIP 出空表）═══
`--bin <path>` 显式传入  >  仓库内 `ref/decoded/ALL_ACTINFO.BIN`  >  `/Users/se818/porsche-mapper`
的同一相对路径（本地 RE 目录，只有存在时才用）  >  **退出码 2** 并打印
「缺少 ALL_ACTINFO.BIN，请用 --bin 指定」。
这次是从哪一档解析到的写在 `source.binResolver`（`cli` / `repo-ref` / `mapper`），
产出的绝对路径**不写进数据**（`source.bin` 只留相对路径）—— 数据要能被别人在别的机器上复现。

用法：
    python3 tools/build-actuators.py                    # 重写 data/actuator.json
    python3 tools/build-actuators.py --bin /path/ALL_ACTINFO.BIN
"""
import collections
import hashlib
import json
import re
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'actuator.json'
BIN_REL = 'ref/decoded/ALL_ACTINFO.BIN'
BIN_REPO = ROOT / BIN_REL                     # 仓库内副本（入仓后即可在提交态复现）
MAPPER_HINT = Path('/Users/se818/porsche-mapper')   # 本地 RE 目录（仅在存在时才用）
MISSING_BIN_MSG = '缺少 ALL_ACTINFO.BIN，请用 --bin 指定'

# 名称记录：`[u16 名长][chain 串\0]` 紧跟命令块
REC = re.compile(rb'([\x02-\x60]\x00)(0x[0-9A-Fa-f]{6,8}(?:\$0x[0-9A-Fa-f]{6,8})*)\x00')

# 命令块固定字段（见文件头布局表）
OFF_CAT = 1        # 类别字节
OFF_OPT = 2        # controlOption(2F) / sub(31)
OFF_SID = 3        # UDS SID
OFF_ADDR = 6       # 逐项地址 u16 **LE**
OFF_TAIL = 10      # 选择器/变体序号（非载荷）
CANON_LEN = 11     # 典型命令块长度（实测 39,043 条同构）
ALT_REC_LEN = 27   # 第二种记录形态（SID 画在 +2，+6 读数与规范块不同）
CAT_CONTAINER = 0xFF
SID_IO = 0x2F      # InputOutputControlByIdentifier
SID_ROUTINE = 0x31  # RoutineControl
SID_RECORD = 0x30  # 有标识符但本目录不构帧

# DID/RID 命名空间底线：低于它的地址要有 GAG 实测背书才算已验证
# （2F 的 4 条 0x00xx 与 31 的 13 条 0x00xx 因此落进 unresolved，不是删除）
ADDR_FLOOR = 0x0100

DEFAULT_IO_STATE = 'FF 00 00 00'
DEFAULT_IO_OPTION = 0x03


def die(msg):
    """生成器的硬失败出口：打印原因 + 退出码 2（不产出任何文件）。"""
    print(msg, file=sys.stderr)
    sys.exit(2)


def resolve_bin(argv):
    """解析 ALL_ACTINFO.BIN 的位置，返回 `(Path, resolver)`。

    优先级（逐档，前档不给就退到后档；全都没有就硬失败）：
      1. `--bin <path>` / `--bin=<path>`  → resolver='cli'
      2. 仓库内 `ref/decoded/ALL_ACTINFO.BIN` → resolver='repo-ref'
      3. 本地 RE 目录的同名相对路径 → resolver='mapper'
    显式传了 `--bin` 但文件不存在时**不回落**（显式优先，静默换输入比失败更危险）。
    """
    cli = None
    args = list(argv)
    while args:
        a = args.pop(0)
        if a == '--bin':
            if not args:
                die(f'--bin 需要一个路径参数。{MISSING_BIN_MSG}')
            cli = args.pop(0)
        elif a.startswith('--bin='):
            cli = a.split('=', 1)[1]
        elif a in ('-h', '--help'):
            print(__doc__)
            sys.exit(0)
        else:
            die(f'未知参数 {a!r}。用法：python3 tools/build-actuators.py [--bin <ALL_ACTINFO.BIN>]')

    if cli is not None:
        p = Path(cli).expanduser()
        if not p.is_file():
            die(f'--bin 指定的文件不存在：{p}')
        return p, 'cli'
    if BIN_REPO.is_file():
        return BIN_REPO, 'repo-ref'
    hint = MAPPER_HINT / BIN_REL
    if hint.is_file():
        return hint, 'mapper'
    die(MISSING_BIN_MSG)
    raise AssertionError('unreachable')   # die() 已退出；此行为类型检查占位



def u16(blob, off):
    return struct.unpack_from('<H', blob, off)[0]


def u32(blob, off):
    return struct.unpack_from('<I', blob, off)[0]


def parse_index(blob):
    """解析头部平台块索引表：`[u8 id][u16 名长][名\\0][u32 指针]` ×N。

    表从偏移 1 起（偏移 0 是文件级标志字节），干净解析到 0xAD 结束 —— 与记录流起点一致。
    返回 (entries, table_end)，entries 按指针升序、去掉 ptr==0 / 名=='0' 的占位项。
    """
    p, out = 1, []
    while p + 7 <= len(blob):
        idx = blob[p]
        name_len = u16(blob, p + 1)
        if not (0 < name_len <= 60) or p + 3 + name_len + 4 > len(blob):
            break
        raw = blob[p + 3:p + 3 + name_len]
        if not raw.endswith(b'\x00'):
            break
        name = raw[:-1].decode('latin1', 'replace')
        if not name or not all(32 <= ord(c) < 127 for c in name):
            break
        ptr = u32(blob, p + 3 + name_len)
        out.append({'id': idx, 'name': name, 'ptr': ptr})
        p += 1 + 2 + name_len + 4
    # 单调递增才可信；指针 0 / 名 '0' 是占位
    blocks = sorted(
        (e for e in out if e['ptr'] > 0 and e['name'] != '0'),
        key=lambda e: e['ptr'],
    )
    return blocks, p


def block_of(off, blocks, table_end):
    """记录偏移 → 所属平台块名（指针 ≤ off 的最后一个块）；落在表内返回 'header'。"""
    if off < table_end:
        return 'header'
    name = 'header'
    for e in blocks:
        if off >= e['ptr']:
            name = e['name']
        else:
            break
    return name


def scan_records(blob):
    """扫全部名称记录，返回按文档序的记录列表（含命令块字节）。"""
    ms = []
    for m in REC.finditer(blob):
        slen = u16(blob, m.start())
        chain = m.group(2).decode()
        if slen == len(chain) + 1:
            ms.append((m.start(), m.end(), chain))
    recs = []
    for k, (st, en, chain) in enumerate(ms):
        nxt = ms[k + 1][0] if k + 1 < len(ms) else len(blob)
        recs.append({'chain': chain, 'nameOff': st, 'cmd': blob[en:nxt]})
    return recs


def is_canonical(cmd):
    """典型命令块：11 字节，且 +4/+8 两个 u16 恒 0（布局自检，过滤异族长记录）。"""
    return (len(cmd) == CANON_LEN
            and cmd[4:6] == b'\x00\x00'
            and cmd[8:10] == b'\x00\x00')


def scan_layout_conflicts(by_chain):
    """找「同一 chain 同时有 11 字节规范块与 27 字节块，且两者 +6 地址集合不相交」的 chain。

    27 字节块的形态是 `[var][cat=0x10][0x31 @+2][00 00][addr u16 LE @+6][00 00][尾 16 字节]`，
    尾段把地址的两个字节**重复了两遍**（tail+1、tail+10），所以 `05 00` 是地址本身而不是
    噪声；同族 11 字节块里 `20 04` ↔ 地址 0x0420 也证明了这两个字节是 **LE**。
    于是 27 字节块的 +6 槽位读数是**另一个值**，与规范块的地址不同。

    ⚠️ 本函数**只报告冲突，不做取舍**：哪个形态是权威静态无法判定，所以不动 did/rid。
    返回值 `{chain: {'canonAddrs': [...], 'canonCount': n, 'altCmd': bytes,
                     'altAddr': int, 'altCount': n}}`。
    """
    out = {}
    for chain, rs in by_chain.items():
        canon = [r['cmd'] for r in rs if is_canonical(r['cmd'])]
        alt = [r['cmd'] for r in rs if len(r['cmd']) == ALT_REC_LEN]
        if not canon or not alt:
            continue
        caddrs = {u16(c, OFF_ADDR) for c in canon}
        aaddrs = [u16(c, OFF_ADDR) for c in alt]
        if caddrs & set(aaddrs):
            continue                      # 有交集 = 同一地址的另一种写法，不算冲突
        out[chain] = {
            'canonAddrs': sorted(caddrs),
            'canonCount': len(canon),
            'altCmd': alt[0],
            'altAddr': aaddrs[0],
            'altCount': len(alt),
        }
    return out


def layout_fields(layout, chosen):
    """把布局冲突落成条目字段（`rawLayoutConflict` / `cmdRaw` / `rawLayoutCandidates`）。

    `chosen` 是当前条目实际使用的地址（did/rid），**原样保留**；另一种形态的读数只并列记录。
    ⚠️ 本字段是**事实陈述**（这种记录形态存在、`+6` 读 X），不是候选地址列表：
    `rawLayoutCandidates` 的值一律**不**进 `didCandidates`/`ridCandidates`。
    """
    alt = layout['altAddr']
    return {
        'rawLayoutConflict': True,
        'cmdRaw': layout['altCmd'].hex(' ').upper(),
        'rawLayoutCandidates': [
            {'layout': 'cmd-block-11B', 'addrSlot': OFF_ADDR, 'endian': 'le',
             'value': chosen, 'valueHex': f'0x{chosen:04X}',
             'occurrences': layout['canonCount'],
             'note': ('规范 11 字节块（+4/+8 恒 00 00）：本目录采用此值，'
                      '它同时出现在 didCandidates / ridCandidates 里')},
            {'layout': 'cmd-block-27B', 'addrSlot': OFF_ADDR, 'endian': 'le',
             'value': alt, 'valueHex': f'0x{alt:04X}',
             'occurrences': layout['altCount'],
             'note': ('同一 chain 的另一种记录形态（27 字节，尾部把该双字节重复两遍）：'
                      '+6 槽位读数与规范块不同；不采用、仅记录，且**不进入候选地址列表**')},
        ],
    }



def lib_params(grout, rid, sub):
    """GAG 实测例程库里 (RID, sub) 的参数串；无实测返回 None（不猜）。"""
    for key in (f'0x{rid:04X}', f'0x{rid:X}'):
        entries = grout.get(key)
        if not entries:
            continue
        for e in entries:
            raw = str(e.get('sub', '')).strip()
            try:
                esub = int(raw.replace('0x', ''), 16) if raw.lower().startswith('0x') else int(raw, 10)
            except ValueError:
                continue
            if esub == sub:
                return (e.get('params') or '').replace(' ', '').upper()
    return None


def gag_all(grout):
    """GAG 例程库全量 → `{(sub, rid): params}`（供长度交叉核对用，不只查 283 条）。"""
    out = {}
    for key, entries in grout.items():
        try:
            rid = int(key, 16)
        except ValueError:
            continue
        for e in entries or []:
            raw = str(e.get('sub', '')).strip()
            try:
                sub = int(raw.replace('0x', ''), 16) if raw.lower().startswith('0x') else int(raw, 10)
            except ValueError:
                continue
            out[(sub, rid)] = (e.get('params') or '').replace(' ', '').upper()
    return out


def load_seq_templates(path):
    """第二张 31 模板表：data/function-sequences.json（687 功能 / 8047 条 31 帧）。

    帧形如 `31 <sub 1B> <rid 2B BE> <params…>`，由 `tools/build-function-sequences.py`
    从 `libPORSCHE_SPECF.so` 逐字节读出（不是合成）。返回 `{(sub, rid): {payload hex…}}`，
    payload 已去空格大写，`''` 表示该调用点是 4 字节无参形态。
    """
    doc = json.loads(path.read_text())
    tab = {}
    frames = 0
    for fn in doc.get('functions') or []:
        for cmd in fn.get('cmds') or []:
            tok = str(cmd).split()
            if len(tok) < 4 or tok[0].upper() != '31':
                continue
            try:
                sub = int(tok[1], 16)
                rid = int(tok[2] + tok[3], 16)
            except ValueError:
                continue
            tab.setdefault((sub, rid), set()).add(''.join(tok[4:]).upper())
            frames += 1
    return tab, frames


PLACEHOLDER_MODULE = re.compile(r'^[^/]+/#\d+$')


def load_module_index(path):
    """模块目录 `data/actinfo-modules.json` → `{(sid, addr, chain): {模块标签}}`。

    只读这张表，**不重新解析 BIN**（BIN 复算已由门禁负责，不做第三份解析器）。
    `(sid, addr, chain)` 三元组来自 `modules[].groups[].records[]`，正好回答
    「哪个模块在这个 chain 上用这个地址」—— 这才是判"能否按模块拆开"的正确粒度
    （光用 chainIndex[addr] 会得到"该地址在全库出现过的模块"，那是过宽的集合）。
    占位模块名（`E1/#12` 这类无名字变体）在这里就滤掉：它们不得算作可拆。
    """
    doc = json.loads(path.read_text())
    idx = {}
    for mod in doc.get('modules') or []:
        blk = mod.get('block') or ''
        name = (mod.get('moduleName') or '').strip()
        tag = f'{blk}/{name}' if name else f"{blk}/#{mod.get('idx')}"
        placeholder = (not name) or bool(PLACEHOLDER_MODULE.match(tag))
        for g in mod.get('groups') or []:
            for r in g.get('records') or []:
                addr = r.get('addr')
                if isinstance(addr, str):
                    addr = int(addr, 16) if addr.lower().startswith('0x') else int(addr, 10)
                key = (str(r.get('sid')).upper(), int(addr or 0), r.get('chain'))
                idx.setdefault(key, set())
                if not placeholder:
                    idx[key].add(tag)
    return doc, idx



def classify_multi_by_module(chain, sid_tag, addrs, mod_idx):
    """多址条目能否按模块拆开（只用 `data/actinfo-modules.json` 的索引）。

    返回 `(resolve, moduleResolution, sets)`：
      · 任一候选在该 chain 下**没有**模块记录 → `multi-address` / `not-applicable`
        （判不了就判不了：空集合与任何集合都"不相交"，据此宣称可拆是假阳性；
        27 字节布局冲突的值不参与本判定，所以它不会靠这个分支蒙过 —— 它压根不进候选列表）
      · 两候选模块集**不相交** → `multi-resolved-by-module` / `separable`
      · 相交 → `ambiguous-in-module` / `ambiguous`
    """
    sets = [set(mod_idx.get((sid_tag, a, chain), set())) for a in addrs]
    if any(not s for s in sets):
        return 'multi-address', 'not-applicable', sets
    if not set.intersection(*sets):
        return 'multi-resolved-by-module', 'separable', sets
    return 'ambiguous-in-module', 'ambiguous', sets


RESOLVE_FIELD = {'2F': ('didResolve', 'didResolveBasis'), '31': ('ridResolve', 'ridResolveBasis')}


def resolve_address(row, chain, sid_tag, real_addrs, mod_idx):
    """地址确定性判定（2F / 31 共用一套，只是字段名前缀不同）。

    `real_addrs` = 该 chain 该 SID 下**真实候选地址**（按文档序）。27 字节布局给出的
    第二个值不算"真实候选"（那不是另一个 ECU 的地址，而是同一记录的另一种画法），
    所以它**不进** `real_addrs`，也不影响本判定 —— 只在 `rawLayoutConflict` /
    `rawLayoutCandidates` 里如实记录。

    返回判决标签：`single` / `multi-resolved` / `ambiguous` / `multi-unjudged`
    """
    rf, bf = RESOLVE_FIELD[sid_tag]
    addr = real_addrs[0]
    row['addrBelowFloor'] = addr < ADDR_FLOOR
    if len(real_addrs) == 1:
        # 单址：同 (block,chain,sid) 下所有规范记录给出同一 id —— 判据不涉及地址高低，
        # 所以那 16 条 0x00xx 也在这里被判为可信（原来的 unverified 是判据错，不是数据错）。
        # 有 27 字节布局冲突时仍然是 single-address（规范形态下唯一），由 rawLayoutConflict 另记。
        row[rf] = 'single-address'
        row[bf] = 'record-unique'
        return 'single'
    highs = {a >> 8 for a in real_addrs}
    row['multiAddressBasis'] = 'high-byte-differs' if len(highs) > 1 else 'high-byte-same'
    resolve, mres, sets = classify_multi_by_module(chain, sid_tag, real_addrs, mod_idx)
    row[rf] = resolve
    row['moduleResolution'] = mres
    if resolve == 'multi-resolved-by-module':
        # 只存"各地址自己的模块名"（两集合不相交，所以这就是全部信息），不存全量模块表
        row['resolvedModuleNames'] = [
            {'addr': a, 'addrHex': f'0x{a:04X}', 'modules': sorted(s)}
            for a, s in zip(real_addrs, sets)
        ]
        return 'multi-resolved'
    return 'ambiguous' if resolve == 'ambiguous-in-module' else 'multi-unjudged'


# 驱动禁用的三条理由（互不覆盖，可能同时成立 → 用「；」拼）
PARAMS_MULTI_REASON = '参数有多个包内候选，需模块上下文才能定型'
PARAMS_NONE_REASON = '包内无该 (sub,rid) 的 31 模板，原厂记录里也未出现过'
ADDR_AMBIG_REASON = '该功能在本模块内有两个候选地址，模块级无法消歧'


def apply_drive_gate(row, reasons):
    """把「不能安全驱动」的理由落到条目上（只有一个入口，避免两处各写一套）。"""
    rs = [r for r in reasons if r]
    if rs:
        row['driveDisabled'] = True
        row['driveDisabledReason'] = '；'.join(rs)


def resolve_params_31(rid, sub, grout, seq_tab):
    """0x31 参数六桶（互斥穷尽），返回 `(字段 dict, 桶名)`。

    · gag-lib 非空 / gag-lib 空 —— GAG 实测例程库优先（唯一有实测背书的源）
    · specf-seq 唯一 —— 包内第二张表（function-sequences）给出**唯一非空**载荷
    · specf-seq 多值 —— 多个候选，**不挑**（标定值猜错等于写坏 ECU）
    · specf-seq-empty —— 该 (sub,rid) 的载荷集恰为 {''}（4 字节形态是它唯一形态）
    · no-template —— 两表都没有，且原厂 236 条 31 帧里 0 次出现
    """
    g = lib_params(grout, rid, sub)
    s = seq_tab.get((sub, rid))
    if g:
        return {'params': g, 'paramsSrc': 'gag-lib', 'paramsResolved': 'unique'}, 'gagLibNonEmpty'
    if g is not None:
        return {'params': '', 'paramsSrc': 'gag-lib', 'paramsResolved': 'unique'}, 'gagLibEmpty'
    if s is None:
        return {'params': '', 'paramsSrc': 'no-template', 'paramsResolved': 'none'}, 'noTemplate'
    nonempty = sorted(x for x in s if x)
    empty_variant = '' in s
    if not nonempty:
        return {'params': '', 'paramsSrc': 'specf-seq-empty', 'paramsResolved': 'unique',
                'paramsCandidates': [], 'paramsEmptyVariant': True}, 'specfSeqEmpty'
    if len(nonempty) == 1:
        out = {'params': nonempty[0], 'paramsSrc': 'specf-seq', 'paramsResolved': 'unique',
               'paramsCandidates': nonempty}
        if empty_variant:
            out['paramsEmptyVariant'] = True
        return out, 'specfSeqUnique'
    out = {'params': '', 'paramsSrc': 'specf-seq', 'paramsResolved': 'multi',
           'paramsCandidates': nonempty}
    if empty_variant:
        out['paramsEmptyVariant'] = True
    return out, 'specfSeqMulti'


def main():
    blob_path, bin_resolver = resolve_bin(sys.argv[1:])
    blob = blob_path.read_bytes()
    blocks, table_end = parse_index(blob)
    recs = scan_records(blob)

    # 正本 = git HEAD 的 2506 条验证集（名称/chain/平台），本脚本只加字段不改集合
    orig = json.loads(subprocess.check_output(['git', 'show', 'HEAD:data/actuator.json'], cwd=ROOT))
    gact = json.loads((ROOT / 'data' / 'gag-actuators.json').read_text())
    gmap = {it['did']: it for it in gact['items']}
    grout = json.loads((ROOT / 'data' / 'gag-routines.json').read_text()).get('routines', {})
    # ★ 第二张 31 模板表（包内、可复算）：只接 GAG 一个源会漏掉 123 条本来就有参数的例程
    seq_tab, seq_frames = load_seq_templates(ROOT / 'data' / 'function-sequences.json')
    gag_tab = gag_all(grout)
    # ★ 模块目录（判"多址能否按模块拆开"，只读表不重解析 BIN）
    mod_doc, mod_idx = load_module_index(ROOT / 'data' / 'actinfo-modules.json')
    model_sha = hashlib.sha256((ROOT / 'data' / 'actinfo-modules.json').read_bytes()).hexdigest()
    gag_dids = set(gmap)
    gag_rids = set()
    for key in grout:
        try:
            gag_rids.add(int(key, 16))
        except ValueError:
            continue

    by_chain = {}
    for r in recs:
        by_chain.setdefault(r['chain'], []).append(r)
    layouts = scan_layout_conflicts(by_chain)

    items = []
    unresolved = []
    # （旧版这里还有个 conflicts 列表：按 (block,chain,sid) 抓"同键多址"。
    #   现在同链多址由 didCandidates/didResolve 显式表达 —— 它是**数据事实**（两个 ECU
    #   各有一份同名执行器），不是"冲突"，所以不再叫 conflict、也不判失败。）

    block_counter = {}
    stat = collections.defaultdict(int)   # 计数器（key 含 did:/rid:/params: 等前缀）

    for it in orig['items']:
        chain = it['chain']
        row = dict(it)
        occ = by_chain.get(chain) or []
        layout = layouts.get(chain)
        n_unres = len(unresolved)      # 本条目是否已进 unresolved（防重复计数）

        # ── 候选地址集合：**只按 SID 分组，不跨 SID 比较** ──────────────
        #   理由（已确证）：0x30 的 +6 槽位是 KWP2000 的 localId（1 字节语义），
        #   与 0x2F 的 2 字节 DID 根本不是同一个字段；同一条 chain 在库里会同时有
        #   `2F/0x7001`（DME）与 `2F/0x0110`（另一个 ECU）—— 那是两个真实 ECU 各一份
        #   同名执行器，不是解析错，也不能靠"取第一个"糊过去。
        #   候选按全库统计（跨平台块），因为同块内同名同 SID 多址恰恰是模块级歧义。
        canon = [(r, r['cmd']) for r in occ if is_canonical(r['cmd'])]
        containers = [r for r in occ if len(r['cmd']) > OFF_CAT and r['cmd'][OFF_CAT] == CAT_CONTAINER]

        row.pop('did', None)
        row.pop('didHex', None)
        row.pop('rid', None)
        row.pop('ridHex', None)
        row.pop('ctrlSrc', None)   # 旧字段语义是"控制形态来源"，实测只有 40 条命中却标了 149 条：
        #                            已由 stateSrc（measured/default 二值）取代，不留旧名免混标

        if containers:
            stat['container'] += 1
            block = block_of(containers[0]['nameOff'], blocks, table_end)
            row.update({
                'form': 'container',
                'container': True,
                'block': block,
                'ctrlBytes': containers[0]['cmd'].hex(' ').upper(),
                'addrVerified': None,      # 容器没有"单个逐项地址"，不适用（≠ 未验证）
            })
            block_counter[block] = block_counter.get(block, 0) + 1
            items.append(row)
            continue

        stat['withRecord'] += 1
        if not canon:
            stat['other'] += 1
            block = block_of(occ[0]['nameOff'], blocks, table_end) if occ else '?'
            row.update({'form': 'other', 'block': block, 'addrVerified': None})
            block_counter[block] = block_counter.get(block, 0) + 1
            items.append(row)
            continue

        r0, cmd0 = canon[0]
        block = block_of(r0['nameOff'], blocks, table_end)
        sid = cmd0[OFF_SID]
        group = [c for r, c in canon if c[OFF_SID] == sid]
        order, votes = [], {}
        for c in group:
            a = u16(c, OFF_ADDR)
            if a not in votes:
                votes[a] = 0
                order.append(a)
            votes[a] += 1
        addr = order[0]                       # 文档序首见：可复算、不发明（只是"默认展示值"）
        cmd = next(c for c in group if u16(c, OFF_ADDR) == addr)
        row['block'] = block
        row['ctrlBytes'] = cmd.hex(' ').upper()
        row['cmdVariant'] = cmd[0]
        row['recordTail'] = cmd[OFF_TAIL] if len(cmd) > OFF_TAIL else None  # +10 选择器（非载荷）
        block_counter[block] = block_counter.get(block, 0) + 1

        if sid == SID_IO:
            stat['io'] += 1
            row['form'] = '2f'
            row['did'] = addr
            row['didHex'] = f'0x{addr:04X}'
            # 候选清单（全量，按首次出现序，带出现次数与是否命中实测）
            row['didCandidates'] = [
                {'did': a, 'didHex': f'0x{a:04X}', 'highByte': f'0x{a >> 8:02X}',
                 'inGag': a in gmap, 'count': votes[a]}
                for a in order
            ]
            # didResolve（**结构标签** + 模块判决，口径见文件头 §7）：
            #   single-address            单址：同 (block,chain,sid) 下所有规范记录给同一 id
            #   multi-resolved-by-module  多址但两候选的模块集不相交 → 按模块可唯一确定
            #   ambiguous-in-module       多址且模块集相交 → 模块级不可消歧（禁驱动）
            #   multi-address             多址但判不了（某候选在该 chain 下无模块记录）
            #   另：multiAddressBasis（只有 high-byte-differs / high-byte-same 两个取值）
            #      + moduleResolution（separable / ambiguous / not-applicable）
            #   27 字节布局冲突**不进候选列表**（见文件头 §7 语义红线），只由 rawLayoutConflict 另记
            real_dids = list(order)
            res2f = resolve_address(row, chain, '2F', real_dids, mod_idx)
            stat[f'did:{res2f}'] = stat.get(f'did:{res2f}', 0) + 1
            if res2f == 'single':
                stat['resolveSingle'] += 1
            else:
                stat['resolveMulti'] += 1
                stat[f'basis:{row["multiAddressBasis"]}'] = stat.get(f'basis:{row["multiAddressBasis"]}', 0) + 1
            if layout:
                # 同一 chain 的 27 字节块在 +6 处给出另一个值：只记录，不改 did
                # （didCandidates 的口径必须是「规范块 +6 地址集合」，门禁拿它跟 BIN 逐条对齐，
                #  往里面塞非规范候选会让「数据自己决定门禁比什么」）
                row.update(layout_fields(layout, addr))
            row['addrVerified'] = True     # 地址判定已由 resolve_address 给出（unverified 已清零）
            row['addrBelowFloor'] = addr < ADDR_FLOOR
            apply_drive_gate(row, [ADDR_AMBIG_REASON if res2f == 'ambiguous' else None])
            if row['addrBelowFloor']:
                unresolved.append({'chain': chain, 'block': block, 'form': '2f',
                                   'addr': f'0x{addr:04X}', 'resolve': row['didResolve'],
                                   'reason': 'addr-below-floor-namespace'})
            g = gmap.get(addr)
            if g:
                # stateSrc 只有两个取值：measured（该 DID 在 GAG 实测集里，state 取自 observedStates）
                # / default（无实测，record 默认 FF 00 00 00）。不再有第三个"假实测"标签。
                stat['gagMeasured'] += 1
                row['drive'] = {'controlOption': g['drive'].get('controlOption', DEFAULT_IO_OPTION),
                                'state': g['drive'].get('state', DEFAULT_IO_STATE)}
                row['release'] = {'controlOption': g['release'].get('controlOption', 0),
                                  'state': g['release'].get('state', '')}
                row['stateSrc'] = 'measured'
            else:
                stat['recordDefault'] += 1
                row['drive'] = {'controlOption': cmd[OFF_OPT], 'state': DEFAULT_IO_STATE}
                row['release'] = {'controlOption': 0, 'state': ''}
                row['stateSrc'] = 'default'

        elif sid == SID_ROUTINE:
            stat['routine'] += 1
            sub = cmd[OFF_OPT]
            row['form'] = '31'
            row['rid'] = addr
            row['ridHex'] = f'0x{addr:04X}'
            row['sub'] = sub
            real_rids = list(order)          # 规范 11 字节形态下的候选（27 字节布局的值不在其中）
            # ★ 候选清单只列规范块 +6 地址集合：27 字节块的读数写进 rawLayoutCandidates，
            #   绝不追加到这里 —— 那是"同一 ECU 的另一种记录写法"，不是"另一个 ECU 的拷贝"，
            #   混进来还会把「2F 13 + 31 5 = 18」这条与地址歧义研究对齐的恒等式打破。
            row['ridCandidates'] = [
                {'rid': a, 'ridHex': f'0x{a:04X}', 'inGagLib': a in gag_rids, 'count': votes[a]}
                for a in order
            ]
            # ── 地址判定（与 2F 同一套；含模块目录判"能否按模块拆开"）──
            res31 = resolve_address(row, chain, '31', real_rids, mod_idx)
            stat[f'rid:{res31}'] = stat.get(f'rid:{res31}', 0) + 1
            if res31 == 'single':
                stat['ridSingle'] += 1
            else:
                stat['ridMulti'] += 1
                stat[f'ridBasis:{row["multiAddressBasis"]}'] = stat.get(
                    f'ridBasis:{row["multiAddressBasis"]}', 0) + 1
            if layout:
                row.update(layout_fields(layout, addr))
            row['addrVerified'] = True
            if row['addrBelowFloor']:
                unresolved.append({'chain': chain, 'block': block, 'form': '31',
                                   'addr': f'0x{addr:04X}', 'resolve': row['ridResolve'],
                                   'reason': 'addr-below-floor-namespace'})
            # ── 参数：GAG 例程库 + 包内 function-sequences 两张表，六桶互斥穷尽 ──
            pfields, bucket = resolve_params_31(addr, sub, grout, seq_tab)
            stat[f'params:{bucket}'] += 1
            row.update(pfields)
            apply_drive_gate(row, [
                ADDR_AMBIG_REASON if res31 == 'ambiguous' else None,
                PARAMS_MULTI_REASON if bucket == 'specfSeqMulti' else None,
                PARAMS_NONE_REASON if bucket == 'noTemplate' else None,
            ])

        elif sid == SID_RECORD:
            # 0x30 = InputOutputControlBy**Local**Identifier：+6 处是 **1 字节 LID**（实测 0x04..0x28，
            # +7 恒 0），不是 2 字节 DID —— 不设 did、不构帧，且**不计入 2F 条目数**。
            stat['record'] += 1
            row['form'] = '30'
            row['lid'] = cmd[OFF_ADDR]
            row['sid'] = SID_RECORD
            row['addrVerified'] = None
            row['lidCandidates'] = order

        else:
            stat['other'] += 1
            row['form'] = 'other'
            row['addrVerified'] = None     # 非标识符服务：不适用

        items.append(row)

    # ── 统计（全部现算，写进 source.stats 供门禁独立复核）──
    f2f = [i for i in items if i.get('form') == '2f']
    f31 = [i for i in items if i.get('form') == '31']
    cont = [i for i in items if i.get('form') == 'container']
    entry_frames_2f = set()
    for i in f2f:
        dr = i['drive']
        entry_frames_2f.add(f"2F{i['did']:04X}{dr['controlOption']:02X}{(dr.get('state') or '').replace(' ', '').upper()}")
    # 记录侧 0x2F 地址全集（候选并集）—— 用于门禁的守恒等式：
    #   distinct(选定 did) + Σ(每个多址条目的候选数-1) === distinct(记录侧 0x2F 地址)
    raw_dids_2f = {c['did'] for i in f2f for c in (i.get('didCandidates') or [])}
    extra_candidates = sum(len(i['didCandidates']) - 1 for i in f2f if len(i.get('didCandidates') or []) > 1)
    multi_2f = [{'chain': i['chain'], 'name': i.get('name'), 'didResolve': i.get('didResolve'),
                 'multiAddressBasis': i.get('multiAddressBasis'),
                 'addrs': [c['didHex'] for c in i['didCandidates']]}
                for i in f2f if len(i.get('didCandidates') or []) > 1]
    multi_31 = [{'chain': i['chain'], 'name': i.get('name'), 'ridResolve': i.get('ridResolve'),
                 'multiAddressBasis': i.get('multiAddressBasis'),
                 'rawLayoutConflict': bool(i.get('rawLayoutConflict')),
                 'addrs': [c['ridHex'] for c in i['ridCandidates']]}
                for i in f31 if len(i.get('ridCandidates') or []) > 1]
    # 布局冲突清单（两种记录形态在 +6 处给出不同地址；只报告，不做取舍）
    layout_conflicts = [
        {'chain': i['chain'], 'name': i.get('name'), 'form': i.get('form'),
         'selected': i.get('didHex') or i.get('ridHex'),
         'candidates': [f"{c['layout']}={c['valueHex']}" for c in i['rawLayoutCandidates']],
         'cmdRaw': i['cmdRaw'],
         'chainOccurrences': [c['occurrences'] for c in i['rawLayoutCandidates']]}
        for i in items if i.get('rawLayoutConflict')
    ]
    # 参数六桶（现算，互斥穷尽）：单一个总数会把"没模板"和"多候选"混成一件事
    PARAM_BUCKETS = ('gagLibNonEmpty', 'gagLibEmpty', 'specfSeqUnique',
                     'specfSeqMulti', 'specfSeqEmpty', 'noTemplate')
    params_stats = {b: stat[f'params:{b}'] for b in PARAM_BUCKETS}
    params_unresolved = params_stats['specfSeqMulti'] + params_stats['noTemplate']
    # 候选级低地址（低于命名空间底线）：**现算**，与「选定地址未验证」分开记
    cand_below = []
    for i in items:
        cands = i.get('didCandidates') or i.get('ridCandidates') or []
        low = [c.get('didHex') or c.get('ridHex')
               for c in cands if (c.get('did') if 'did' in c else c.get('rid')) < ADDR_FLOOR]
        if low:
            cand_below.append({'chain': i['chain'], 'name': i.get('name'), 'form': i.get('form'),
                               'selected': i.get('didHex') or i.get('ridHex'),
                               'belowFloorCandidates': low,
                               'rawLayout': bool(i.get('rawLayoutConflict'))})
    # 地址判定：unverified 已清零（判据从"地址高低"换成"同 (block,chain,sid) 记录是否同 id"）
    addr_unverified = len([i for i in items if i.get('addrVerified') is False])
    below_floor = len([i for i in items if i.get('addrBelowFloor') is True])
    def _res_counts(rows, field):
        out = collections.OrderedDict(
            (k, 0) for k in ('single-address', 'multi-resolved-by-module',
                             'ambiguous-in-module', 'multi-address'))
        for r in rows:
            out[r.get(field)] = out.get(r.get(field), 0) + 1
        return out
    def _mod_counts(rows):
        out = collections.OrderedDict((k, 0) for k in ('separable', 'ambiguous', 'not-applicable'))
        for r in rows:
            if r.get('moduleResolution'):
                out[r['moduleResolution']] = out.get(r['moduleResolution'], 0) + 1
        return out
    # 参数长度交叉核对：GAG 与 SEQ 都有**非空**载荷的 (sub,rid) 对
    param_len_pairs = 0
    param_len_bad = []
    for (sub, rid), gval in gag_tab.items():
        if not gval or (sub, rid) not in seq_tab:
            continue
        others = {x for x in seq_tab[(sub, rid)] if x}
        if not others:
            continue
        param_len_pairs += 1
        if not any(len(x) == len(gval) for x in others):
            param_len_bad.append({'key': f'{sub:02X}|{rid:04X}', 'sub': sub, 'rid': rid,
                                  'gag': gval, 'gagLen': len(gval) // 2,
                                  'seq': sorted(others),
                                  'seqLens': sorted({len(x) // 2 for x in others})})
    param_len_present = sum(1 for k in gag_tab if k in seq_tab)
    stats = {
        'canonicalRecordLen': CANON_LEN,
        'recordsScanned': len(recs),
        'items': len(items),
        'withRecord': stat['withRecord'],
        'containerRecords': sum(1 for r in recs
                                if len(r['cmd']) > OFF_CAT and r['cmd'][OFF_CAT] == CAT_CONTAINER),
        'containerItems': len(cont),
        'entries2f': len(f2f),
        'distinctDids2f': len({i['did'] for i in f2f}),
        'distinctFrames2f': len(entry_frames_2f),
        'distinctRawDids2f': len(raw_dids_2f),
        'extraCandidates2f': extra_candidates,
        'entries31': len(f31),
        'distinctRids31': len({i['rid'] for i in f31}),
        'distinctRawRids31': len({c['rid'] for i in f31 for c in (i.get('ridCandidates') or [])}),
        'entries30': len([i for i in items if i.get('form') == '30']),
        'entriesOther': len([i for i in items if i.get('form') == 'other']),
        'didResolve': dict(_res_counts(f2f, 'didResolve')),
        'didModuleResolution': dict(_mod_counts(f2f)),
        'didMultiAddressBasis': {
            k.split(':', 1)[1]: v for k, v in stat.items() if k.startswith('basis:')
        },
        'ridResolve': dict(_res_counts(f31, 'ridResolve')),
        'ridModuleResolution': dict(_mod_counts(f31)),
        'ridMultiAddressBasis': {
            k.split(':', 1)[1]: v for k, v in stat.items() if k.startswith('ridBasis:')
        },
        'multiAddressEntries2f': len(multi_2f),
        'multiAddressEntries31': len(multi_31),
        'layoutConflictItems': len(layout_conflicts),
        'stateSrcMeasured': len([i for i in items if i.get('stateSrc') == 'measured']),
        'stateSrcMeasuredDistinctDids': len({i['did'] for i in items if i.get('stateSrc') == 'measured'}),
        'stateSrcDefault': len([i for i in items if i.get('stateSrc') == 'default']),
        'paramsMatchedGagLib': len([i for i in f31 if i.get('paramsSrc') == 'gag-lib']),
        'paramsNonEmpty31': len([i for i in f31 if str(i.get('params') or '').strip()]),
        'paramsUnresolved': params_unresolved,
        'addrUnverified': addr_unverified,
        'addrBelowFloor': below_floor,
        'addrUnverifiedListed': len(unresolved),
        'candidateAddrBelowFloor': len(cand_below),
        'gagDidCount': len(gag_dids),
    }

    doc = {
        'schemaVersion': 4,
        'kind': 'actuator',
        'platform': orig.get('platform'),
        'count': len(items),
        'note': ('执行器测试项：名称=参考诊断仪 DSTREAM 正式名。did/rid=命令块 +6 处 u16 小端，'
                 '按 SID 分组后取值（0x2F→DID / 0x31→RID；0x30 的 +6 是 KWP localId，单列 lid、不出帧）。'
                 'didCandidates/ridCandidates = 「**规范 11 字节记录形态**下的全部候选地址」'
                 '（同链多址＝多个 ECU 各有一份同名功能）。'
                 'didResolve/ridResolve 词表：single-address（同 (block,chain,sid) 下所有规范记录给同一 id）'
                 ' / multi-resolved-by-module（多址但两候选的模块集不相交，配 resolvedModuleNames 可唯一定位）'
                 ' / ambiguous-in-module（多址且模块集相交，模块级无法消歧 → driveDisabled）'
                 ' / multi-address（多址但判不了：某候选在该 chain 下无模块记录）。'
                 '多址另带 multiAddressBasis（只有 high-byte-differs / high-byte-same 两个取值，'
                 '只描述"候选高字节是否相同"这个数值事实，不声称分属不同功能域）'
                 ' 与 moduleResolution（separable/ambiguous/not-applicable）。'
                 'rawLayoutConflict=true 的条目：同一 chain 还存在**另一种记录形态**（27 字节块）在 +6 '
                 '给出不同地址，两种形态并列在 rawLayoutCandidates（含 cmdRaw 原始字节），'
                 '**取值未改动**；另一形态的读数**不进入候选地址列表** —— 它不是另一个 ECU 的拷贝，'
                 '所以 single-address 与 rawLayoutConflict=true 可以并存。'
                 'stateSrc 只有 measured（did 命中 GAG 71 实测集，state 取自 observedStates）/'
                 ' default（无实测，记录默认 FF 00 00 00），两者不可混标。'
                 '0x31 的 params 取两个源：gag-lib（GAG 实测例程库）/ specf-seq（包内 function-sequences 的 '
                 '31 模板）；paramsSrc ∈ {gag-lib, specf-seq, specf-seq-empty, no-template} 四值，'
                 'paramsResolved ∈ {unique, multi, none} 三值。paramsResolved=multi 的条目 params 留空但 '
                 'paramsCandidates 列出全部候选（不挑）；no-template 表示两表都没有模板 —— 两者都不等于'
                 '"不需要参数"，未解决条数见 source.paramsUnresolved，六桶分解见 source.paramsStats。'),
        # view（分组/分页/431 侧条目数证据）由原文档整体继承：
        # 条目集合与顺序未变，pages 的 itemIdx/start-end 索引依然成立，重算反而会丢证据坐标。
        'view': orig.get('view'),
        'source': {
            'bin': BIN_REL,
            'binResolver': bin_resolver,
            'size': len(blob),
            'sha256': hashlib.sha256(blob).hexdigest(),
            'rule': ('命令块 [0]变体 [1]类别(2F→01/31→10/容器→FF) [2]controlOption|sub '
                     '[3]SID [4:6]==00 00 [6:8]地址 u16 **LE** [8:10]==00 00 [10]选择器；'
                     '候选地址按 SID 分组统计（不跨 SID 比较，0x30 槽位是 localId）；'
                     'block=头部索引表 [u8 id][u16 名长][名\\0][u32 指针] 的指针边界'),
            'generatedBy': 'tools/build-actuators.py',
            'reproduce': ('python3 tools/build-actuators.py --bin <ALL_ACTINFO.BIN>'
                          '（bin 只记相对路径 ' + BIN_REL + '；用 sha256 认文件，不认绝对路径）'),
            'stats': stats,
            'paramsStats': params_stats,             # 六桶（现算、互斥穷尽，和 = form:'31' 条数）
            'paramsUnresolved': params_unresolved,   # 现算 = specfSeqMulti + noTemplate
            'paramsUnresolvedNote': ('"多候选"与"没模板"是两件事，所以既给总数也给六桶：'
                                     'paramsResolved=multi 有模板但不敢挑，no-template 连模板都没有。'
                                     '两者都不能判定"可安全无参执行"。'),
            'paramsSources': {
                'gagLib': 'data/gag-routines.json（GAG 实测例程库，(RID,sub) → params）',
                'specfSeq': ('data/function-sequences.json（687 功能 / %d 条 31 帧 / %d 个 (sub,rid) 模板；'
                             '由 tools/build-function-sequences.py 从 libPORSCHE_SPECF.so 逐字节读出）'
                             % (seq_frames, len(seq_tab))),
                'lengthCrossCheck': {
                    'rule': ('同一 (sub,rid) 在两源都有**非空**载荷时，两源长度必须相等；'
                             '不等即视为模板串错位（白名单见 paramLengthWhitelist）'),
                    'pairsBothPresent': param_len_present,
                    'pairsBothNonEmpty': param_len_pairs,
                    'mismatches': param_len_bad,
                },
            },
            'moduleTable': {
                'path': 'data/actinfo-modules.json',
                'sha256': model_sha,
                'generatedBy': 'python3 tools/export-actinfo-modules.py',
                'verify': 'python3 tools/export-actinfo-modules.py --verify',
                'resolution': mod_doc.get('resolution'),
                'note': ('只读此表判"多址能否按模块拆开"，不重新解析 BIN（BIN 复算由门禁负责）；'
                         '占位模块名（如 E1/#12）不计入可拆。'),
            },
            'multiAddress2f': multi_2f,
            'multiAddress31': multi_31,
            'layoutConflicts': layout_conflicts,
            'layoutConflictNote': ('两种记录形态并列记录，不做取舍：'
                                   'didCandidates/ridCandidates 只含**规范 11 字节块** +6 地址'
                                   '（同链多址＝多个 ECU 各一份同名功能）；'
                                   'rawLayoutCandidates 只描述**同一 chain 的另一种 27 字节记录形态**'
                                   '及其 +6 读数（该值**不进入候选地址列表**）。'
                                   '所以 rawLayoutConflict=true 的条目仍可能是 single-address。'),
            'candidateAddrBelowFloor': cand_below,
            'unresolved': unresolved,
        },
        'items': items,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n')

    print(f"actuator.json: {len(items)} 项 · 平台块 {len(block_counter)} 个 "
          f"{dict(sorted(block_counter.items(), key=lambda x: -x[1]))}")
    print(f"  输入: {blob_path}（binResolver={bin_resolver}），{len(blob)} B，"
          f"sha256={hashlib.sha256(blob).hexdigest()[:16]}…")
    print(f"  形态: 2f={stats['entries2f']}(DID {stats['distinctDids2f']} 个 / 帧 {stats['distinctFrames2f']} 个) "
          f"31={stats['entries31']}(RID {stats['distinctRids31']} 个) "
          f"30={stats['entries30']} container={stats['containerItems']}"
          f"(记录 {stats['containerRecords']} 条) other={stats['entriesOther']}")
    print(f"  didResolve: {stats['didResolve']} · basis {stats['didMultiAddressBasis']}"
          f"（多址条目 {stats['multiAddressEntries2f']} 条）")
    print(f"  ridResolve: {stats['ridResolve']} · basis {stats['ridMultiAddressBasis']}"
          f"（多址条目 {stats['multiAddressEntries31']} 条）")
    print(f"  布局冲突: {stats['layoutConflictItems']} 条（两种记录形态 +6 值不同，未改取值）")
    print(f"  记录侧地址全集: 0x2F {stats['distinctRawDids2f']} 个 · 0x31 {stats['distinctRawRids31']} 个"
          f"（多址条目的未选候选共 {stats['extraCandidates2f']} 个地址位次）")
    print(f"  状态来源: measured={stats['stateSrcMeasured']} 条 / {stats['stateSrcMeasuredDistinctDids']} 个 DID · "
          f"default={stats['stateSrcDefault']} 条")
    print(f"  31 参数六桶: {params_stats} · 未解决 paramsUnresolved={params_unresolved}")
    print(f"  参数长度交叉核对: 两源都有记录 {param_len_present} 对 / 都有非空 {param_len_pairs} 对 · "
          f"长度不符 {len(param_len_bad)} 对 {[b['key'] for b in param_len_bad]}")
    print(f"  地址判定: unverified={stats['addrUnverified']}（已清零）· 低于命名空间底线 {stats['addrBelowFloor']} 条")
    print(f"    did(2F) {stats['didResolve']} · module {stats['didModuleResolution']}")
    print(f"    rid(31) {stats['ridResolve']} · module {stats['ridModuleResolution']}")
    print(f"    驱动禁用 {len([i for i in items if i.get('driveDisabled')])} 条")
    for lc in layout_conflicts:
        print(f"    ⚠ [{lc['form']}] {lc['name']} chain={lc['chain']} 采用 {lc['selected']}"
              f" · 候选 {' / '.join(lc['candidates'])}")
    for it in items[:6]:
        print(f"  {it.get('didHex') or it.get('ridHex') or '—':7s} [{it.get('form','?'):9s}] "
              f"[{it.get('block','?')}] {it['name'][:40]}")


if __name__ == '__main__':
    main()
