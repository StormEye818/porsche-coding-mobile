/** 极简事件发射器（对齐 PortLike 接口用） */
export class Emitter {
  constructor() { this._h = {}; }
  on(evt, fn) { (this._h[evt] ||= []).push(fn); return this; }
  emit(evt, ...args) { (this._h[evt] || []).forEach((f) => f(...args)); }
  removeListener(evt, fn) {
    const a = this._h[evt];
    if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    return this;
  }
}
