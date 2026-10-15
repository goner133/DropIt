/*
 * dc-lite: a small runtime for the DROP IT! site components.
 * Renders .dc.html-style templates ({{holes}}, <sc-if>, <sc-for>, <dc-import>),
 * keeps each component's state, and patches the DOM with morphdom so animations
 * do not rebuild the page and clicks never land on a node that was just replaced.
 * Components are compiled into window.DC_COMPONENTS by build.py.
 */
(function () {
  'use strict';
  var REG = window.DC_COMPONENTS || {};
  var morph = window.morphdom;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function DCLogic(p) { this.props = p || {}; this.state = {}; }
  DCLogic.prototype.setState = function (o) {
    var next = typeof o === 'function' ? o(this.state, this.props) : o;
    for (var k in next) if (Object.prototype.hasOwnProperty.call(next, k)) this.state[k] = next[k];
    if (this.__inst) this.__inst.invalidate();
  };
  window.DCLogic = DCLogic;

  var defs = {};
  function def(name) {
    if (defs[name]) return defs[name];
    var d = REG[name];
    if (!d) throw new Error('dc-lite: unknown component ' + name);
    var t = document.createElement('template');
    t.innerHTML = d.tpl;
    var Cls = new Function('DCLogic', d.script + '\n;return Component;')(DCLogic);
    return (defs[name] = { tpl: t.content, Cls: Cls, defaults: d.defaults || {}, types: d.types || {} });
  }

  function lookup(scope, path) {
    var parts = path.trim().split('.'), o = scope;
    for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
    return o;
  }
  var WHOLE = /^\s*\{\{([^}]+)\}\}\s*$/, ANY = /\{\{([^}]+)\}\}/g;
  function interp(str, scope) {
    var m = str.match(WHOLE);
    if (m) {
      var e = m[1].trim();
      if (e === 'true') return true;
      if (e === 'false') return false;
      if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
      return lookup(scope, e);
    }
    if (str.indexOf('{{') < 0) return str;
    return str.replace(ANY, function (_, e) { var v = lookup(scope, e); return v == null ? '' : String(v); });
  }
  function camel(s) { return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }
  function coerce(v, type) {
    if (typeof v !== 'string') return v;
    if (type === 'boolean' || v === 'true' || v === 'false') return v === 'true' || (v !== 'false' && v !== '');
    if (type === 'float' || type === 'int' || (/^-?\d+(\.\d+)?$/.test(v) && type !== 'text')) { var n = Number(v); return isNaN(n) ? v : n; }
    return v;
  }

  var uid = 0, pendingMounts = [], queue = [], scheduled = false;
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      var inst = en.target.__dcInst;
      if (!inst) return;
      inst.visible = en.isIntersecting;
      if (inst.visible && inst.dirty) inst.invalidate();
    });
  }, { rootMargin: '200px' }) : null;

  function Inst(name, props, parent) {
    this.name = name; this.def = def(name); this.parent = parent || null;
    this.depth = parent ? parent.depth + 1 : 0;
    this.id = 'dc' + (++uid);
    this.kids = {}; this.visible = true; this.dirty = false; this.mounted = false; this.el = null;
    this.props = this.withDefaults(props);
    this.logic = new this.def.Cls(this.props);
    this.logic.props = this.props;
    this.logic.__inst = this;
  }
  Inst.prototype.withDefaults = function (p) {
    var out = {}, d = this.def.defaults, k;
    for (k in d) out[k] = d[k];
    for (k in p) if (p[k] !== undefined) out[k] = coerce(p[k], this.def.types[k]);
    return out;
  };
  Inst.prototype.setProps = function (p) { this.props = this.withDefaults(p); this.logic.props = this.props; };
  Inst.prototype.build = function () {
    var vals = this.logic.renderVals() || {};
    var wrap = document.createElement('div');
    wrap.setAttribute('data-dc', this.name);
    wrap.setAttribute('data-dc-id', this.id);
    wrap.style.width = '100%';
    var ctx = { inst: this, n: 0, used: {} };
    var nodes = this.def.tpl.childNodes;
    for (var i = 0; i < nodes.length; i++) renderNode(nodes[i], vals, wrap, ctx, false);
    for (var k in this.kids) if (!ctx.used[k]) { this.kids[k].unmount(); delete this.kids[k]; }
    return wrap;
  };
  Inst.prototype.unmount = function () {
    for (var k in this.kids) this.kids[k].unmount();
    this.kids = {};
    if (this.mounted && this.logic.componentWillUnmount) { try { this.logic.componentWillUnmount(); } catch (e) { console.error(e); } }
    if (this.el && io) io.unobserve(this.el);
    this.mounted = false;
  };
  Inst.prototype.invalidate = function () {
    if (!this.mounted) return;
    if (!this.visible) { this.dirty = true; return; }
    if (queue.indexOf(this) < 0) queue.push(this);
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  };
  Inst.prototype.attach = function () {
    var el = document.querySelector('[data-dc-id="' + this.id + '"]');
    if (el && el !== this.el) {
      if (this.el && io) io.unobserve(this.el);
      this.el = el; el.__dcInst = this;
      if (io) io.observe(el);
    }
    for (var k in this.kids) this.kids[k].attach();
  };

  function flush() {
    scheduled = false;
    var list = queue.sort(function (a, b) { return a.depth - b.depth; }); queue = [];
    var done = [];
    list.forEach(function (inst) {
      for (var a = inst; a; a = a.parent) if (done.indexOf(a) >= 0) return;
      var target = inst.el && inst.el.isConnected ? inst.el : document.querySelector('[data-dc-id="' + inst.id + '"]');
      if (!target) return;
      inst.dirty = false;
      patch(target, inst.build());
      inst.attach();
      done.push(inst);
    });
    runMounts();
  }

  function runMounts() {
    var list = pendingMounts; pendingMounts = [];
    list.forEach(function (inst) {
      inst.mounted = true;
      if (inst.logic.componentDidMount) { try { inst.logic.componentDidMount(); } catch (e) { console.error(e); } }
    });
  }

  function patch(from, to) {
    morph(from, to, {
      onBeforeElUpdated: function (a, b) {
        var evs = (a.__dcEv || []).concat(b.__dcEv || []);
        for (var i = 0; i < evs.length; i++) a['on' + evs[i]] = b['on' + evs[i]] || null;
        a.__dcEv = b.__dcEv;
        if (a.tagName === 'DETAILS') b.open = a.open;
        if (a.isEqualNode(b)) return false;
        return true;
      }
    });
  }

  function renderNode(node, scope, out, ctx, inSvg) {
    if (node.nodeType === 3) { out.appendChild(document.createTextNode(interp(node.textContent, scope))); return; }
    if (node.nodeType !== 1) return;
    var tag = node.tagName.toLowerCase(), i, c;
    if (tag === 'sc-if') {
      if (interp(node.getAttribute('value') || '', scope)) for (c = node.firstChild; c; c = c.nextSibling) renderNode(c, scope, out, ctx, inSvg);
      return;
    }
    if (tag === 'sc-for') {
      var list = interp(node.getAttribute('list') || '', scope) || [], as = node.getAttribute('as') || 'item';
      for (i = 0; i < list.length; i++) {
        var s2 = Object.create(scope); s2[as] = list[i]; s2.$index = i;
        for (c = node.firstChild; c; c = c.nextSibling) renderNode(c, s2, out, ctx, inSvg);
      }
      return;
    }
    if (tag === 'dc-import') {
      var name = node.getAttribute('name'), props = {};
      for (i = 0; i < node.attributes.length; i++) {
        var at = node.attributes[i];
        if (at.name === 'name' || at.name.indexOf('hint-') === 0) continue;
        props[camel(at.name)] = interp(at.value, scope);
      }
      var key = (ctx.n++) + ':' + name, kid = ctx.inst.kids[key];
      if (kid) kid.setProps(props); else { kid = ctx.inst.kids[key] = new Inst(name, props, ctx.inst); pendingMounts.push(kid); }
      ctx.used[key] = 1;
      out.appendChild(kid.build());
      return;
    }
    var svg = node.namespaceURI === SVG_NS;
    var el = svg ? document.createElementNS(SVG_NS, node.localName) : document.createElement(tag);
    for (i = 0; i < node.attributes.length; i++) {
      var a = node.attributes[i], n = a.name;
      if (n.indexOf('hint-') === 0) continue;
      if (/^on[a-z]+$/.test(n) && a.value.indexOf('{{') >= 0) {
        var fn = interp(a.value, scope);
        if (typeof fn === 'function') { var ev = n.slice(2); el['on' + ev] = fn; (el.__dcEv || (el.__dcEv = [])).push(ev); }
        continue;
      }
      var v = interp(a.value, scope);
      if (v === false || v == null) continue;
      if (typeof v === 'string' && v.indexOf('@root/') === 0) v = (window.DC_BASE || '') + v.slice(6);
      el.setAttribute(n, v === true ? '' : String(v));
    }
    var kids = tag === 'template' ? node.content.childNodes : node.childNodes;
    for (i = 0; i < kids.length; i++) renderNode(kids[i], scope, el, ctx, svg);
    out.appendChild(el);
  }

  function mount(name, props, host) {
    var inst = new Inst(name, props || {}, null);
    pendingMounts.unshift(inst);
    var el = inst.build();
    var old = host.firstElementChild;
    if (old) patch(old, el); else host.appendChild(el);
    inst.attach();
    runMounts();
    return inst;
  }
  window.dcLite = { mount: mount };

  function boot() {
    var hosts = document.querySelectorAll('[data-dc-page]');
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i], props = {};
      try { props = JSON.parse(h.getAttribute('data-dc-props') || '{}'); } catch (e) {}
      mount(h.getAttribute('data-dc-page'), props, h);
    }
    if (location.hash) { var t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
