/**
 * adapter.js — 接头适配层（对齐同门工具的识别/抽象）。
 *
 * 支持的接头类型（用 ATI 识别）：
 *   vlinker  — vLinker MS / V-LINK 系列（我们主力）
 *   elm      — 通用 ELM327
 *   obdkey   — OBDKey
 *   vagcom   — VagCom / KKL
 *
 * 任何接头只要实现 PortLike（write + on('data')）就能接进 Elm327。
 */
import { Emitter } from './emitter.js';

/** 把一个「字节流源」适配成 PortLike */
class PortLike extends Emitter {
  constructor() {
    super();
  }
  write(_data) { throw new Error('未实现 write'); }
}

/** 识别接头类型 —— 用 ATI 探 */
export class InterfaceTester {
  /** @param {import('./elm327.js').Elm327} elm */
  constructor(elm) {
    this.elm = elm;
    this.log = [];
  }

  async identify(spec = { name: '适配器' }) {
    const out = { kind: null, name: '', version: '', ok: false, log: [] };
    const push = (m) => { this.log.push(m); out.log.push(m); };

    push(`正在复位适配器（${spec.name}）…`);
    let id = '';
    try {
      await this.elm.cmd('ATZ', 6000);
      id = (await this.elm.cmd('ATI', 3000)) || '';
    } catch (e) {
      push(`复位失败: ${e.message}`);
      return out;
    }
    push(`ATI → ${JSON.stringify(id)}`);

    // vLinker / V-LINK
    if (/VLINKER|V-LINK/i.test(id)) {
      out.kind = 'vlinker';
      const m = id.match(/v?(\d+)\.(\d+)/i);
      out.version = m ? `v${m[1]}.${m[2]}` : '';
      out.ok = true;
    } else if (/OBDKEY/i.test(id)) {
      out.kind = 'obdkey'; out.name = 'OBDKey'; out.ok = true;
    } else if (/VAG|KKL/i.test(id)) {
      out.kind = 'vagcom'; out.name = 'VagCom/KKL'; out.ok = true;
    } else if (/ELM327|ELM/i.test(id)) {
      out.kind = 'elm';
      const m = id.match(/(\d+)\.(\d+)/);
      out.version = m ? `ELM327 ${m[1]}.${m[2]}` : 'ELM327';
      out.ok = true;
    }
    out.name = id.trim() || spec.name;
    return out;
  }
}

export { PortLike };
