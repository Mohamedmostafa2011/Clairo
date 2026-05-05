/**
 * LogicForge — Digital Logic Circuit Designer
 * script.js — Main application logic
 * 
 * Architecture:
 *  - State: single source of truth for all circuit data
 *  - LogicEngine: pure logic evaluation
 *  - Renderer: SVG rendering from state
 *  - InteractionManager: mouse/keyboard event handling
 *  - App: bootstrap & UI wiring
 */

'use strict';

/* ============================================================
   CONSTANTS
   ============================================================ */
const GRID = 20;
const PIN_RADIUS = 5;
const GATE_W = 80;
const GATE_H = 60;
const INPUT_W = 64;
const INPUT_H = 36;
const OUTPUT_R = 20;

let nodeCounter = 0;
const uid = () => `n${++nodeCounter}`;

/* ============================================================
   LOGIC ENGINE
   Evaluates circuit state — pure functions, no side effects
   ============================================================ */
const LogicEngine = {
  evaluate(type, inputs) {
    const vals = inputs.map(v => !!v);
    switch (type) {
      case 'AND':  return vals.length > 0 && vals.every(Boolean) ? 1 : 0;
      case 'OR':   return vals.some(Boolean) ? 1 : 0;
      case 'NOT':  return vals[0] ? 0 : 1;
      case 'NAND': return vals.length > 0 && vals.every(Boolean) ? 0 : 1;
      case 'NOR':  return vals.some(Boolean) ? 0 : 1;
      case 'XOR':  return vals.filter(Boolean).length % 2 !== 0 ? 1 : 0;
      case 'XNOR': return vals.filter(Boolean).length % 2 === 0 ? 1 : 0;
      default:     return 0;
    }
  },

  propagate(state) {
    const { components, wires } = state;
    const values = {};

    // Topological sort via Kahn's algorithm
    const inDegree = {};
    const adj = {};  // nodeId -> [nodeId]

    components.forEach(c => {
      inDegree[c.id] = 0;
      adj[c.id] = [];
    });

    wires.forEach(w => {
      if (!adj[w.fromId]) adj[w.fromId] = [];
      adj[w.fromId].push(w.toId);
      inDegree[w.toId] = (inDegree[w.toId] || 0) + 1;
    });

    const queue = components.filter(c => inDegree[c.id] === 0).map(c => c.id);
    const sorted =[];

    while (queue.length) {
      const id = queue.shift();
      sorted.push(id);
      (adj[id] || []).forEach(nid => {
        inDegree[nid]--;
        if (inDegree[nid] === 0) queue.push(nid);
      });
    }

    // Evaluate in topological order
    sorted.forEach(id => {
      const comp = components.find(c => c.id === id);
      if (!comp) return;

      if (comp.type === 'input') {
        values[id] = comp.value;
        return;
      }

      // Gather input values for this gate
      const inputWires = wires.filter(w => w.toId === id);
      const inputVals = inputWires.map(w => values[w.fromId] ?? 0);

      if (comp.type === 'output') {
        values[id] = inputVals[0] ?? 0;
      } else {
        values[id] = LogicEngine.evaluate(comp.type, inputVals);
      }
    });

    // Set wire active state
    wires.forEach(w => {
      w.active = !!(values[w.fromId]);
    });

    // Update component output values
    components.forEach(c => {
      c.outputValue = values[c.id] ?? 0;
    });

    return values;
  }
};

/* ============================================================
   STATE MANAGER
   Single source of truth for all circuit data
   ============================================================ */
const State = {
  components: [],
  wires:[],
  selected: new Set(),       // Set of ids
  tool: 'select',            // 'select' | 'wire'
  simulating: false,
  theme: 'dark',

  // View transform
  viewX: 0, viewY: 0, viewScale: 1,

  // History
  history:[],
  historyIndex: -1,

  // Clipboard
  clipboard:[],

  // Serialise for history
  snapshot() {
    return JSON.stringify({
      components: this.components.map(c => ({...c})),
      wires: this.wires.map(w => ({...w}))
    });
  },

  // Push to history
  pushHistory() {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(this.snapshot());
    this.historyIndex = this.history.length - 1;
    if (this.history.length > 60) {
      this.history.shift();
      this.historyIndex--;
    }
  },

  undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.loadSnapshot(this.history[this.historyIndex]);
      return true;
    }
    return false;
  },

  redo() {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.loadSnapshot(this.history[this.historyIndex]);
      return true;
    }
    return false;
  },

  loadSnapshot(snap) {
    const data = JSON.parse(snap);
    this.components = data.components;
    this.wires = data.wires;
    this.selected.clear();
  },

  addComponent(comp) {
    this.components.push(comp);
  },

  removeSelected() {
    const ids = [...this.selected];
    this.components = this.components.filter(c => !ids.includes(c.id));
    this.wires = this.wires.filter(w => !ids.includes(w.id) &&
      !ids.includes(w.fromId) && !ids.includes(w.toId));
    this.selected.clear();
    this.pushHistory();
  },

  addWire(wire) {
    this.wires.push(wire);
    this.pushHistory();
  },

  getComponent(id) {
    return this.components.find(c => c.id === id);
  }
};

/* ============================================================
   RENDERER
   Draws circuit state to SVG
   ============================================================ */
const Renderer = {
  svg: null,
  wiresLayer: null,
  compLayer: null,
  uiLayer: null,

  init() {
    this.svg = document.getElementById('main-canvas');
    this.wiresLayer = document.getElementById('wires-layer');
    this.compLayer = document.getElementById('components-layer');
    this.uiLayer = document.getElementById('ui-layer');
    this.applyTransform();
  },

  applyTransform() {
    const t = `translate(${State.viewX},${State.viewY}) scale(${State.viewScale})`;
    this.wiresLayer.setAttribute('transform', t);
    this.compLayer.setAttribute('transform', t);
    this.uiLayer.setAttribute('transform', t);
    document.getElementById('zoom-level').textContent =
      Math.round(State.viewScale * 100) + '%';
  },

  render() {
    this.renderComponents();
    this.renderWires();
    this.updateStatus();
    MiniMap.update();
    this.applyTransform();
  },

  renderComponents() {
    this.compLayer.innerHTML = '';
    State.components.forEach(comp => {
      const g = this.createComponent(comp);
      this.compLayer.appendChild(g);
    });
  },

  renderWires() {
    this.wiresLayer.innerHTML = '';
    State.wires.forEach(wire => {
      const el = this.createWire(wire);
      if (el) this.wiresLayer.appendChild(el);
    });
  },

  createComponent(comp) {
    const g = svgEl('g', {
      class: `component-group ${State.selected.has(comp.id) ? 'selected' : ''} ${comp.type}`,
      'data-id': comp.id,
      transform: `translate(${comp.x},${comp.y})`
    });

    switch (comp.type) {
      case 'input':   this.buildInput(g, comp); break;
      case 'output':  this.buildOutput(g, comp); break;
      default:        this.buildGate(g, comp); break;
    }

    g.addEventListener('mousedown', e => InteractionManager.onComponentMouseDown(e, comp.id));
    g.addEventListener('contextmenu', e => InteractionManager.onContextMenu(e, comp.id));

    return g;
  },

  buildGate(g, comp) {
    const isSelected = State.selected.has(comp.id);
    const gateTypes = { AND:true, OR:true, NOT:true, NAND:true, NOR:true, XOR:true, XNOR:true };
    const numInputs = (comp.type === 'NOT') ? 1 : 2;
    const w = GATE_W, h = GATE_H;
    const pins = this.getGatePins(comp);

    // Gate body based on type
    const bodyPath = this.getGatePath(comp.type, w, h);
    const body = svgEl('path', {
      d: bodyPath,
      class: `gate-body ${isSelected ? 'selected' : ''}`,
      fill: 'var(--gate-fill)',
      stroke: isSelected ? 'var(--gate-selected)' : 'var(--gate-stroke)',
      'stroke-width': 1.5,
      'stroke-linejoin': 'round'
    });
    g.appendChild(body);

    // Label
    const lbl = svgEl('text', {
      x: w / 2, y: h / 2,
      class: 'gate-label',
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      fill: 'var(--text-secondary)',
      'font-size': 9,
      'font-family': 'JetBrains Mono, monospace',
      'pointer-events': 'none'
    });
    lbl.textContent = comp.type;
    g.appendChild(lbl);

    // Input pins
    pins.inputs.forEach((pin, i) => {
      this.addPin(g, pin.x, pin.y, 'in', i, comp);
    });

    // Output pin
    const op = pins.output;
    this.addPin(g, op.x, op.y, 'out', 0, comp);
  },

  getGatePath(type, w, h) {
    const m = h / 2; // midY
    switch (type) {
      case 'AND':
        return `M4,4 H${w*0.45} Q${w},4 ${w},${m} Q${w},${h-4} ${w*0.45},${h-4} H4 Z`;
      case 'NAND':
        return `M4,4 H${w*0.42} Q${w-10},4 ${w-10},${m} Q${w-10},${h-4} ${w*0.42},${h-4} H4 Z`;
      case 'OR':
        return `M4,4 Q14,4 ${w*0.5},4 Q${w+2},4 ${w+2},${m} Q${w+2},${h-4} ${w*0.5},${h-4} Q14,${h-4} 4,${h-4} Q12,${m} 4,4 Z`;
      case 'NOR':
        return `M4,4 Q14,4 ${w*0.45},4 Q${w-8},4 ${w-8},${m} Q${w-8},${h-4} ${w*0.45},${h-4} Q14,${h-4} 4,${h-4} Q12,${m} 4,4 Z`;
      case 'XOR':
        return `M8,4 Q18,4 ${w*0.5},4 Q${w+2},4 ${w+2},${m} Q${w+2},${h-4} ${w*0.5},${h-4} Q18,${h-4} 8,${h-4} Q16,${m} 8,4 Z M2,4 Q9,${m} 2,${h-4}`;
      case 'XNOR':
        return `M8,4 Q18,4 ${w*0.45},4 Q${w-8},4 ${w-8},${m} Q${w-8},${h-4} ${w*0.45},${h-4} Q18,${h-4} 8,${h-4} Q16,${m} 8,4 Z M2,4 Q9,${m} 2,${h-4}`;
      case 'NOT':
        return `M4,4 L${w-10},${m} L4,${h-4} Z`;
      default:
        return `M4,4 H${w-4} V${h-4} H4 Z`;
    }
  },

  getGatePins(comp) {
    const w = GATE_W, h = GATE_H;
    const type = comp.type;
    if (type === 'NOT') {
      return { inputs: [{ x: 0, y: h/2 }], output: { x: w, y: h/2 } };
    }
    const xOffset = (type === 'XOR' || type === 'XNOR') ? 8 : 0;
    return {
      inputs:[
        { x: xOffset, y: h * 0.3 },
        { x: xOffset, y: h * 0.7 }
      ],
      output: { x: w + (type === 'NAND' || type === 'NOR' || type === 'XNOR' ? 0 : 0), y: h/2 }
    };
  },

  getAbsPins(comp) {
    if (comp.type === 'input') {
      return { inputs:[], output: { x: comp.x + INPUT_W, y: comp.y + INPUT_H/2 } };
    }
    if (comp.type === 'output') {
      // Input pin is at cx:0, cy:OUTPUT_R in local space → absolute = comp.x + 0, comp.y + OUTPUT_R
      return { inputs:[{ x: comp.x, y: comp.y + OUTPUT_R }], output: null };
    }
    const pins = this.getGatePins(comp);
    return {
      inputs: pins.inputs.map(p => ({ x: comp.x + p.x, y: comp.y + p.y })),
      output: { x: comp.x + pins.output.x, y: comp.y + pins.output.y }
    };
  },

  addPin(g, x, y, dir, idx, comp) {
    const circle = svgEl('circle', {
      cx: x, cy: y,
      r: PIN_RADIUS,
      fill: dir === 'out' ? (comp.outputValue ? 'var(--wire-active)' : 'var(--wire-inactive)') : 'var(--bg-tertiary)',
      stroke: 'var(--gate-stroke)',
      'stroke-width': 1.5,
      class: 'pin',
      'data-comp-id': comp.id,
      'data-dir': dir,
      'data-idx': idx
    });

    circle.addEventListener('mousedown', e => {
      e.stopPropagation();
      if (dir === 'out') {
        InteractionManager.startWire(e, comp.id, dir, idx);
      }
    });

    circle.addEventListener('mouseup', e => {
      e.stopPropagation();
      if (dir === 'in') {
        InteractionManager.endWire(e, comp.id, dir, idx);
      }
    });

    g.appendChild(circle);
    return circle;
  },

  buildInput(g, comp) {
    const isSelected = State.selected.has(comp.id);
    const isOn = comp.value === 1;

    // Background rect
    const rect = svgEl('rect', {
      x: 0, y: 0,
      width: INPUT_W, height: INPUT_H,
      rx: 6,
      fill: isOn ? 'var(--green-dim)' : 'var(--accent-dim)',
      stroke: isSelected ? 'var(--gate-selected)' : (isOn ? 'var(--green)' : 'var(--accent)'),
      'stroke-width': 1.5
    });
    g.appendChild(rect);

    // Label
    const lbl = svgEl('text', {
      x: INPUT_W * 0.4,
      y: INPUT_H / 2,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      fill: isOn ? 'var(--green)' : 'var(--accent)',
      'font-size': 13,
      'font-weight': 700,
      'font-family': 'JetBrains Mono, monospace',
      'pointer-events': 'none'
    });
    lbl.textContent = comp.label || 'A';
    g.appendChild(lbl);

    // Value badge
    const badge = svgEl('text', {
      x: INPUT_W * 0.78,
      y: INPUT_H / 2,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      fill: isOn ? 'var(--green)' : 'var(--text-dim)',
      'font-size': 11,
      'font-weight': 700,
      'font-family': 'JetBrains Mono, monospace',
      'pointer-events': 'none'
    });
    badge.textContent = comp.value;
    g.appendChild(badge);

    // Toggle area
    const hitArea = svgEl('rect', {
      x: 0, y: 0,
      width: INPUT_W, height: INPUT_H,
      fill: 'transparent',
      'data-toggle': comp.id
    });
    hitArea.addEventListener('click', e => {
      e.stopPropagation();
      if (State.simulating) {
        comp.value = comp.value === 1 ? 0 : 1;
        State.pushHistory();
        LogicEngine.propagate(State);
        Renderer.render();
        PropertiesPanel.update();
      }
    });
    hitArea.style.cursor = State.simulating ? 'pointer' : 'default';
    g.appendChild(hitArea);

    // Output pin (right side)
    this.addPin(g, INPUT_W, INPUT_H / 2, 'out', 0, comp);
  },

  buildOutput(g, comp) {
    const isSelected = State.selected.has(comp.id);
    const isOn = comp.outputValue === 1;
    const r = OUTPUT_R;

    // Outer circle
    const outer = svgEl('circle', {
      cx: r, cy: r, r: r,
      fill: 'var(--bg-tertiary)',
      stroke: isSelected ? 'var(--gate-selected)' : (isOn ? 'var(--green)' : 'var(--gate-stroke)'),
      'stroke-width': 1.5
    });
    g.appendChild(outer);

    // Inner LED
    const inner = svgEl('circle', {
      cx: r, cy: r, r: r * 0.55,
      fill: isOn ? 'var(--green)' : 'rgba(58,64,96,0.4)',
      'filter': isOn ? 'url(#glow-green)' : 'none'
    });
    g.appendChild(inner);

    // Label
    const lbl = svgEl('text', {
      x: r, y: r * 2 + 11,
      'text-anchor': 'middle',
      fill: isOn ? 'var(--green)' : 'var(--text-dim)',
      'font-size': 10,
      'font-weight': 700,
      'font-family': 'JetBrains Mono, monospace',
      'pointer-events': 'none'
    });
    lbl.textContent = comp.label || 'X';
    g.appendChild(lbl);

    // Input pin (left side)
    const inputPin = svgEl('circle', {
      cx: 0, cy: r, r: PIN_RADIUS,
      fill: 'var(--bg-tertiary)',
      stroke: 'var(--gate-stroke)',
      'stroke-width': 1.5,
      class: 'pin',
      'data-comp-id': comp.id,
      'data-dir': 'in',
      'data-idx': 0
    });
    inputPin.addEventListener('mouseup', e => {
      e.stopPropagation();
      InteractionManager.endWire(e, comp.id, 'in', 0);
    });
    g.appendChild(inputPin);
  },

  createWire(wire) {
    const fromComp = State.getComponent(wire.fromId);
    const toComp = State.getComponent(wire.toId);
    if (!fromComp || !toComp) return null;

    const fromPins = this.getAbsPins(fromComp);
    const toPins = this.getAbsPins(toComp);

    if (!fromPins.output) return null;
    const toPin = toPins.inputs[wire.toPin] || toPins.inputs[0];
    if (!toPin) return null;

    const x1 = fromPins.output.x, y1 = fromPins.output.y;
    const x2 = toPin.x, y2 = toPin.y;

    const path = svgEl('path', {
      d: bezierPath(x1, y1, x2, y2),
      class: `wire ${wire.active ? 'active' : ''} ${State.selected.has(wire.id) ? 'selected' : ''}`,
      fill: 'none',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'data-wire-id': wire.id
    });

    // Hit area (wider invisible path for easier clicking)
    const hit = svgEl('path', {
      d: bezierPath(x1, y1, x2, y2),
      fill: 'none',
      stroke: 'transparent',
      'stroke-width': 12,
      cursor: 'pointer',
      'data-wire-id': wire.id
    });

    hit.addEventListener('mousedown', e => {
      e.stopPropagation();
      if (State.tool === 'select') {
        if (!e.shiftKey) State.selected.clear();
        State.selected.add(wire.id);
        Renderer.render();
        PropertiesPanel.update();
      }
    });

    const g = svgEl('g');
    g.appendChild(path);
    g.appendChild(hit);
    return g;
  }
};

/* ============================================================
   INTERACTION MANAGER
   All mouse/keyboard/drag events
   ============================================================ */
const InteractionManager = {
  dragging: null,        // { id, offsetX, offsetY }
  wireStart: null,       // { compId, dir, idx }
  previewWire: null,     // SVG path element
  panning: false,
  panStart: null,
  selecting: false,
  selStart: null,
  selRect: null,
  selInitialIds: null,
  spaceDown: false,

  init() {
    const svg = document.getElementById('main-canvas');

    svg.addEventListener('mousedown', e => this.onSvgMouseDown(e));
    svg.addEventListener('mousemove', e => this.onSvgMouseMove(e));
    svg.addEventListener('mouseup', e => this.onSvgMouseUp(e));
    svg.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    svg.addEventListener('contextmenu', e => e.preventDefault());

    document.addEventListener('keydown', e => this.onKeyDown(e));
    document.addEventListener('keyup', e => this.onKeyUp(e));
    document.addEventListener('click', () => ContextMenu.hide());

    // Sidebar drag-and-drop
    document.querySelectorAll('.comp-item').forEach(item => {
      item.addEventListener('dragstart', e => this.onSidebarDragStart(e));
    });
    svg.addEventListener('dragover', e => { e.preventDefault(); });
    svg.addEventListener('drop', e => this.onCanvasDrop(e));
  },

  svgPoint(e) {
    const svg = document.getElementById('main-canvas');
    const rect = svg.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - State.viewX) / State.viewScale,
      y: (e.clientY - rect.top - State.viewY) / State.viewScale
    };
  },

  snapToGrid(val) {
    return Math.round(val / GRID) * GRID;
  },

  onSvgMouseDown(e) {
    if (e.button !== 0) return;
    ContextMenu.hide();

    const pt = this.svgPoint(e);
    const compEl = e.target.closest('.component-group');
    const wireId = e.target.dataset.wireId;

    // Space = pan
    if (this.spaceDown) {
      this.panning = true;
      this.panStart = { x: e.clientX - State.viewX, y: e.clientY - State.viewY };
      document.getElementById('main-canvas').classList.add('cursor-grabbing');
      return;
    }

    if (State.tool === 'wire') return;

    if (!compEl && !wireId) {
      // Start selection rect
      this.selInitialIds = e.shiftKey ? new Set(State.selected) : new Set();
      State.selected = new Set(this.selInitialIds);
      
      this.selecting = true;
      this.selStart = pt;
      this.selRect = svgEl('rect', { class: 'selection-rect', x: pt.x, y: pt.y, width: 0, height: 0 });
      document.getElementById('ui-layer').appendChild(this.selRect);
      Renderer.render();
      PropertiesPanel.update();
    }
  },

  onSvgMouseMove(e) {
    if (this.panning && this.panStart) {
      State.viewX = e.clientX - this.panStart.x;
      State.viewY = e.clientY - this.panStart.y;
      Renderer.applyTransform();
      MiniMap.update();
      return;
    }

    if (this.dragging) {
      const pt = this.svgPoint(e);
      
      if (this.dragMulti) {
        const newX = this.snapToGrid(pt.x - this.dragging.offsetX);
        const newY = this.snapToGrid(pt.y - this.dragging.offsetY);
        const startComp = this.dragMulti.startPos.find(p => p.id === this.dragging.id);
        
        if (startComp) {
          const dx = newX - startComp.x;
          const dy = newY - startComp.y;
          
          this.dragMulti.startPos.forEach(p => {
            const c = State.getComponent(p.id);
            if (c) {
              c.x = p.x + dx;
              c.y = p.y + dy;
            }
          });
        }
      } else {
        const comp = State.getComponent(this.dragging.id);
        if (comp) {
          comp.x = this.snapToGrid(pt.x - this.dragging.offsetX);
          comp.y = this.snapToGrid(pt.y - this.dragging.offsetY);
        }
      }
      Renderer.render();
      return;
    }

    if (this.wireStart) {
      const pt = this.svgPoint(e);
      const fromComp = State.getComponent(this.wireStart.compId);
      if (!fromComp) return;

      const fromPins = Renderer.getAbsPins(fromComp);
      const fx = fromPins.output.x;
      const fy = fromPins.output.y;

      if (!this.previewWire) {
        this.previewWire = svgEl('path', { class: 'wire-preview', id: 'wire-preview-path' });
        document.getElementById('wires-layer').appendChild(this.previewWire);
      }
      this.previewWire.setAttribute('d', bezierPath(fx, fy, pt.x, pt.y));
      return;
    }

    if (this.selecting && this.selStart) {
      const pt = this.svgPoint(e);
      const rx = Math.min(this.selStart.x, pt.x);
      const ry = Math.min(this.selStart.y, pt.y);
      const rw = Math.abs(pt.x - this.selStart.x);
      const rh = Math.abs(pt.y - this.selStart.y);

      this.selRect.setAttribute('x', rx);
      this.selRect.setAttribute('y', ry);
      this.selRect.setAttribute('width', rw);
      this.selRect.setAttribute('height', rh);

      // Select components in rect
      State.selected.clear();
      if (this.selInitialIds) {
        this.selInitialIds.forEach(id => State.selected.add(id));
      }
      State.components.forEach(c => {
        const cx = c.x, cy = c.y;
        const cw = c.type === 'input' ? INPUT_W : (c.type === 'output' ? OUTPUT_R*2 : GATE_W);
        const ch = c.type === 'input' ? INPUT_H : (c.type === 'output' ? OUTPUT_R*2 : GATE_H);
        if (cx + cw > rx && cx < rx + rw && cy + ch > ry && cy < ry + rh) {
          State.selected.add(c.id);
        }
      });

      Renderer.renderComponents();
      return;
    }
  },

  onSvgMouseUp(e) {
    document.getElementById('main-canvas').classList.remove('cursor-grabbing');

    if (this.panning) {
      this.panning = false;
      this.panStart = null;
      return;
    }

    if (this.dragging) {
      State.pushHistory();
      this.dragging = null;
      this.dragMulti = null;
      Renderer.render();
      PropertiesPanel.update();
      return;
    }

    if (this.selecting) {
      this.selecting = false;
      this.selStart = null;
      this.selInitialIds = null;
      if (this.selRect) {
        this.selRect.remove();
        this.selRect = null;
      }
      Renderer.render();
      PropertiesPanel.update();
      return;
    }

    if (this.wireStart) {
      this.cancelWire();
    }
  },

  onComponentMouseDown(e, id) {
    if (this.spaceDown) return;
    if (State.tool === 'wire') return;
    e.stopPropagation();

    if (!e.shiftKey && !State.selected.has(id)) {
      State.selected.clear();
    }
    State.selected.add(id);
    Renderer.render();
    PropertiesPanel.update();

    const pt = this.svgPoint(e);
    const comp = State.getComponent(id);

    this.dragging = {
      id,
      offsetX: pt.x - comp.x,
      offsetY: pt.y - comp.y
    };

    // If multi-selected, log initial coords for rigid body dragging
    if (State.selected.size > 1) {
      this.dragMulti = {
        ids: [...State.selected],
        startPt: pt,
        startPos: State.components.filter(c => State.selected.has(c.id))
          .map(c => ({ id: c.id, x: c.x, y: c.y }))
      };
    } else {
      this.dragMulti = null;
    }
  },

  startWire(e, compId, dir, idx) {
    e.stopPropagation();
    if (State.tool === 'wire' || dir === 'out') {
      // Check if already has outgoing wire (allow fan-out)
      this.wireStart = { compId, dir, idx };
      document.getElementById('main-canvas').classList.add('cursor-crosshair');
    }
  },

  endWire(e, compId, dir, idx) {
    if (!this.wireStart) return;
    e.stopPropagation();

    const from = this.wireStart;
    this.cancelWire();

    // Validate
    if (from.compId === compId) return; // Self-loop
    if (dir !== 'in') return; // Must connect to input pin

    // Check if input already has a wire
    const existing = State.wires.find(w => w.toId === compId && w.toPin === idx);
    if (existing) return; // Already connected

    const wire = {
      id: uid(),
      fromId: from.compId,
      toId: compId,
      fromPin: from.idx,
      toPin: idx,
      active: false
    };

    State.addWire(wire);
    if (State.simulating) {
      LogicEngine.propagate(State);
    }
    Renderer.render();
    playConnectSound();
  },

  cancelWire() {
    this.wireStart = null;
    if (this.previewWire) {
      this.previewWire.remove();
      this.previewWire = null;
    }
    document.getElementById('main-canvas').classList.remove('cursor-crosshair');
  },

  onContextMenu(e, id) {
    e.preventDefault();
    e.stopPropagation();
    if (!State.selected.has(id)) {
      State.selected.clear();
      State.selected.add(id);
      Renderer.render();
      PropertiesPanel.update();
    }
    ContextMenu.show(e.clientX, e.clientY, id);
  },

  onWheel(e) {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    const newScale = Math.max(0.15, Math.min(4, State.viewScale * (1 + delta)));
    const svg = document.getElementById('main-canvas');
    const rect = svg.getBoundingClientRect();

    // Zoom toward cursor
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const ratio = newScale / State.viewScale;
    State.viewX = mouseX - ratio * (mouseX - State.viewX);
    State.viewY = mouseY - ratio * (mouseY - State.viewY);
    State.viewScale = newScale;

    Renderer.applyTransform();
    MiniMap.update();
  },

  onKeyDown(e) {
    const tag = e.target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    if (e.key === ' ') {
      e.preventDefault();
      this.spaceDown = true;
      document.getElementById('main-canvas').classList.add('cursor-grab');
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      State.removeSelected();
      LogicEngine.propagate(State);
      Renderer.render();
      PropertiesPanel.update();
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'z': 
          e.preventDefault(); 
          if (State.undo()) { LogicEngine.propagate(State); Renderer.render(); PropertiesPanel.update(); } 
          break;
        case 'y': 
          e.preventDefault(); 
          if (State.redo()) { LogicEngine.propagate(State); Renderer.render(); PropertiesPanel.update(); } 
          break;
        case 'c': e.preventDefault(); this.copy(); break;
        case 'v': e.preventDefault(); this.paste(); break;
        case 'a': e.preventDefault(); State.components.forEach(c => State.selected.add(c.id)); Renderer.render(); PropertiesPanel.update(); break;
      }
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'v': setTool('select'); break;
      case 'w': setTool('wire'); break;
      case '+': case '=': zoom(1.2); break;
      case '-': zoom(0.8); break;
      case 'f': fitToScreen(); break;
    }
  },

  onKeyUp(e) {
    if (e.key === ' ') {
      this.spaceDown = false;
      document.getElementById('main-canvas').classList.remove('cursor-grab');
      document.getElementById('main-canvas').classList.remove('cursor-grabbing');
    }
  },

  copy() {
    const selected = State.components.filter(c => State.selected.has(c.id));
    State.clipboard = selected.map(c => JSON.parse(JSON.stringify(c)));
  },

  paste() {
    if (!State.clipboard.length) return;
    State.selected.clear();
    const idMap = {};
    const newComps = State.clipboard.map(c => {
      const newId = uid();
      idMap[c.id] = newId;
      const nc = { ...c, id: newId, x: c.x + 40, y: c.y + 40 };
      State.addComponent(nc);
      State.selected.add(newId);
      return nc;
    });
    State.pushHistory();
    if (State.simulating) LogicEngine.propagate(State);
    Renderer.render();
    PropertiesPanel.update();
  },

  onSidebarDragStart(e) {
    const type = e.target.closest('.comp-item').dataset.type;
    e.dataTransfer.setData('text/plain', type);
    e.dataTransfer.effectAllowed = 'copy';
  },

  onCanvasDrop(e) {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/plain');
    if (!type) return;

    const svg = document.getElementById('main-canvas');
    const rect = svg.getBoundingClientRect();
    const rawX = (e.clientX - rect.left - State.viewX) / State.viewScale;
    const rawY = (e.clientY - rect.top - State.viewY) / State.viewScale;
    const x = Math.round(rawX / GRID) * GRID - 40;
    const y = Math.round(rawY / GRID) * GRID - 30;

    createComponent(type, x, y);
  }
};

/* ============================================================
   COMPONENT FACTORY
   ============================================================ */
function createComponent(type, x, y) {
  const id = uid();
  let comp;

  if (type === 'input') {
    // Count existing inputs for default label
    const inputCount = State.components.filter(c => c.type === 'input').length;
    const label = String.fromCharCode(65 + inputCount); // A, B, C...
    comp = { id, type: 'input', x, y, value: 0, outputValue: 0, label };
  } else if (type === 'output') {
    const outputCount = State.components.filter(c => c.type === 'output').length;
    const label = String.fromCharCode(88 + outputCount); // X, Y, Z
    comp = { id, type: 'output', x, y, outputValue: 0, label };
  } else {
    comp = { id, type, x, y, outputValue: 0 };
  }

  State.addComponent(comp);
  State.selected.clear();
  State.selected.add(id);
  State.pushHistory();
  if (State.simulating) LogicEngine.propagate(State);
  Renderer.render();
  PropertiesPanel.update();
}

/* ============================================================
   PROPERTIES PANEL
   ============================================================ */
const PropertiesPanel = {
  update() {
    const panel = document.getElementById('prop-content');
    const ids =[...State.selected];

    if (ids.length === 0) {
      panel.innerHTML = `<div class="no-selection">
        <svg width="40" height="40" viewBox="0 0 40 40" opacity="0.3">
          <rect x="5" y="12" width="20" height="16" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/>
          <line x1="25" y1="18" x2="35" y2="18" stroke="currentColor" stroke-width="1.5"/>
          <line x1="25" y1="22" x2="35" y2="22" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        <p>Select a component to edit its properties</p>
      </div>`;
      return;
    }

    if (ids.length > 1) {
      panel.innerHTML = `<div class="prop-group">
        <div class="prop-label">SELECTION</div>
        <div class="prop-value">${ids.length} items</div>
      </div>`;
      return;
    }

    const comp = State.getComponent(ids[0]);
    if (comp) {
      this.showComponent(comp);
    } else {
      const wire = State.wires.find(w => w.id === ids[0]);
      if (wire) this.showWire(wire);
    }
  },

  showComponent(comp) {
    const panel = document.getElementById('prop-content');
    const val = comp.outputValue ?? 0;

    let html = `
      <div class="prop-group">
        <div class="prop-label">TYPE</div>
        <div class="prop-value">${comp.type.toUpperCase()}</div>
      </div>
      <div class="prop-group">
        <div class="prop-label">ID</div>
        <div class="prop-value" style="color:var(--text-dim);font-size:10px">${comp.id}</div>
      </div>
      <div class="prop-group">
        <div class="prop-label">POSITION</div>
        <div class="prop-value">(${comp.x}, ${comp.y})</div>
      </div>
    `;

    if (comp.label !== undefined) {
      html += `<div class="prop-group">
        <div class="prop-label">LABEL</div>
        <div class="prop-value">${comp.label}</div>
      </div>`;
    }

    html += `<div class="prop-group">
      <div class="prop-label">OUTPUT</div>
      <div class="prop-badge ${val ? 'high' : 'low'}">
        <div style="width:8px;height:8px;border-radius:50%;background:${val ? 'var(--green)' : 'var(--text-dim)'}"></div>
        ${val ? 'HIGH (1)' : 'LOW (0)'}
      </div>
    </div>`;

    if (comp.type === 'input') {
      html += `<div class="prop-group">
        <div class="prop-label">VALUE</div>
        <button class="prop-toggle" onclick="toggleInputValue('${comp.id}')">
          Toggle: ${comp.value ? '1 → 0' : '0 → 1'}
        </button>
      </div>`;
    }

    // Connections
    const outWires = State.wires.filter(w => w.fromId === comp.id);
    const inWires = State.wires.filter(w => w.toId === comp.id);
    html += `<div class="prop-group">
      <div class="prop-label">CONNECTIONS</div>
      <div class="prop-value">In: ${inWires.length} • Out: ${outWires.length}</div>
    </div>`;

    panel.innerHTML = html;
  },

  showWire(wire) {
    const panel = document.getElementById('prop-content');
    panel.innerHTML = `
      <div class="prop-group">
        <div class="prop-label">TYPE</div>
        <div class="prop-value">WIRE</div>
      </div>
      <div class="prop-group">
        <div class="prop-label">SIGNAL</div>
        <div class="prop-badge ${wire.active ? 'high' : 'low'}">
          <div style="width:8px;height:8px;border-radius:50%;background:${wire.active ? 'var(--green)' : 'var(--text-dim)'}"></div>
          ${wire.active ? 'HIGH (1)' : 'LOW (0)'}
        </div>
      </div>
    `;
  }
};

/* ============================================================
   CONTEXT MENU
   ============================================================ */
const ContextMenu = {
  currentId: null,

  show(x, y, id) {
    this.currentId = id;
    const menu = document.getElementById('context-menu');
    const comp = State.getComponent(id);
    document.getElementById('ctx-rename').style.display =
      (comp && (comp.type === 'input' || comp.type === 'output')) ? 'block' : 'none';
    menu.style.display = 'block';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Keep within viewport
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth) menu.style.left = (x - mr.width) + 'px';
    if (mr.bottom > window.innerHeight) menu.style.top = (y - mr.height) + 'px';
  },

  hide() {
    document.getElementById('context-menu').style.display = 'none';
    this.currentId = null;
  }
};

/* ============================================================
   MINIMAP
   ============================================================ */
const MiniMap = {
  canvas: null,
  ctx: null,

  init() {
    this.canvas = document.getElementById('minimap-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.update();
  },

  update() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    const isDark = document.documentElement.dataset.theme !== 'light';
    ctx.fillStyle = isDark ? '#0d0f14' : '#f0f2f8';
    ctx.fillRect(0, 0, W, H);

    if (!State.components.length) return;

    // Find bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    State.components.forEach(c => {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + GATE_W);
      maxY = Math.max(maxY, c.y + GATE_H);
    });

    const pad = 40;
    const scale = Math.min(W / (maxX - minX + pad*2), H / (maxY - minY + pad*2));
    const offX = (W - (maxX - minX) * scale) / 2 - minX * scale;
    const offY = (H - (maxY - minY) * scale) / 2 - minY * scale;

    // Draw wires
    State.wires.forEach(w => {
      const from = State.getComponent(w.fromId);
      const to = State.getComponent(w.toId);
      if (!from || !to) return;
      
      const fromPins = Renderer.getAbsPins(from);
      const toPins = Renderer.getAbsPins(to);
      if (!fromPins.output) return;
      const toPin = toPins.inputs[w.toPin] || toPins.inputs[0];
      if (!toPin) return;

      const fx = fromPins.output.x * scale + offX;
      const fy = fromPins.output.y * scale + offY;
      const tx = toPin.x * scale + offX;
      const ty = toPin.y * scale + offY;

      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = w.active ? '#2ecc71' : (isDark ? '#2d3555' : '#c0c8d8');
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // Draw components
    State.components.forEach(c => {
      const x = c.x * scale + offX;
      const y = c.y * scale + offY;
      const cw = (c.type === 'input' ? INPUT_W : (c.type === 'output' ? OUTPUT_R*2 : GATE_W)) * scale;
      const ch = (c.type === 'input' ? INPUT_H : (c.type === 'output' ? OUTPUT_R*2 : GATE_H)) * scale;
      
      ctx.fillStyle = isDark ? '#1a1e28' : '#ffffff';
      ctx.strokeStyle = State.selected.has(c.id) ? '#4f9cf9' :
        (c.type === 'input' ? '#4f9cf9' : c.type === 'output' ? '#2ecc71' : (isDark ? '#4a5578' : '#8090b8'));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x, y, cw, ch, 2);
      ctx.fill();
      ctx.stroke();
    });

    // Draw viewport indicator
    const mainSvg = document.getElementById('main-canvas');
    const svgW = mainSvg.clientWidth;
    const svgH = mainSvg.clientHeight;
    const vx = (-State.viewX / State.viewScale) * scale + offX;
    const vy = (-State.viewY / State.viewScale) * scale + offY;
    const vw = (svgW / State.viewScale) * scale;
    const vh = (svgH / State.viewScale) * scale;

    const vp = document.getElementById('minimap-viewport');
    vp.style.left = Math.max(0, vx) + 'px';
    vp.style.top = Math.max(0, vy) + 'px';
    vp.style.width = Math.min(vw, W) + 'px';
    vp.style.height = Math.min(vh, H) + 'px';
  }
};

/* ============================================================
   IMPORT / EXPORT
   ============================================================ */
function exportPNG() {
  const isDark = document.documentElement.dataset.theme !== 'light';
  const bounds = getCircuitBounds();
  const pad = 70;
  const watermarkH = 36;
  const scale = 2; // retina

  const W = (bounds.w + pad * 2);
  const H = (bounds.h + pad * 2 + watermarkH);
  const canvas = document.createElement('canvas');
  canvas.width  = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // Palette resolved from theme
  const P = isDark ? {
    bg:         '#0d0f14',
    gateFill:   '#1a1e28',
    gateStroke: '#4a5578',
    wireActive: '#2ecc71',
    wireInact:  '#3a4060',
    textSec:    '#8892a4',
    textDim:    '#4a5568',
    accent:     '#4f9cf9',
    green:      '#2ecc71',
    greenDim:   'rgba(46,204,113,0.18)',
    accentDim:  'rgba(79,156,249,0.15)',
    pinFill:    '#1a1e28',
    ledOff:     'rgba(58,64,96,0.4)',
    border:     '#1a1e28',
    wmark:      '#2a2f42',
  } : {
    bg:         '#f0f2f8',
    gateFill:   '#ffffff',
    gateStroke: '#8090b8',
    wireActive: '#1db955',
    wireInact:  '#c0c8d8',
    textSec:    '#5a6282',
    textDim:    '#9aa0b8',
    accent:     '#2979e8',
    green:      '#1db955',
    greenDim:   'rgba(29,185,85,0.15)',
    accentDim:  'rgba(41,121,232,0.12)',
    pinFill:    '#ffffff',
    ledOff:     '#d0d8e8',
    border:     '#ffffff',
    wmark:      '#dde1ee',
  };

  const ox = -bounds.x + pad; // offset x
  const oy = -bounds.y + pad; // offset y

  // Background
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, W, H);

  // Grid dots (subtle)
  ctx.fillStyle = isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)';
  for (let gx = 0; gx < W; gx += 20)
    for (let gy = 0; gy < H - watermarkH; gy += 20)
      ctx.fillRect(gx, gy, 1, 1);

  // ── WIRES ──────────────────────────────────────────────
  State.wires.forEach(w => {
    const from = State.getComponent(w.fromId);
    const to   = State.getComponent(w.toId);
    if (!from || !to) return;

    const fromPins = Renderer.getAbsPins(from);
    const toPins   = Renderer.getAbsPins(to);
    if (!fromPins.output) return;
    const toPin = toPins.inputs[w.toPin] || toPins.inputs[0];
    if (!toPin) return;

    const x1 = fromPins.output.x + ox, y1 = fromPins.output.y + oy;
    const x2 = toPin.x + ox,           y2 = toPin.y + oy;
    const dx = Math.abs(x2 - x1) * 0.5;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
    ctx.strokeStyle = w.active ? P.wireActive : P.wireInact;
    ctx.lineWidth   = 2;
    ctx.lineCap     = 'round';

    if (w.active) {
      ctx.shadowColor = P.green;
      ctx.shadowBlur  = 6;
    } else {
      ctx.shadowBlur = 0;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  });

  // ── COMPONENTS ─────────────────────────────────────────
  State.components.forEach(comp => {
    const cx = comp.x + ox;
    const cy = comp.y + oy;

    if (comp.type === 'input') {
      drawExportInput(ctx, comp, cx, cy, P);
    } else if (comp.type === 'output') {
      drawExportOutput(ctx, comp, cx, cy, P);
    } else {
      drawExportGate(ctx, comp, cx, cy, P);
    }
  });

  // ── WATERMARK BAR ──────────────────────────────────────
  const barY = H - watermarkH;
  ctx.fillStyle = P.wmark;
  ctx.fillRect(0, barY, W, watermarkH);

  // Divider line
  ctx.strokeStyle = isDark ? '#2d3555' : '#c8cedf';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, barY);
  ctx.lineTo(W, barY);
  ctx.stroke();

  // Load logo and draw watermark text
  const logo = new Image();
  logo.crossOrigin = 'anonymous';
  logo.onload = () => {
    const lH = 20, lW = 20;
    ctx.drawImage(logo, 12, barY + (watermarkH - lH) / 2, lW, lH);

    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.fillStyle = isDark ? '#8892a4' : '#5a6282';
    ctx.textBaseline = 'middle';
    ctx.fillText('Clairo Logic Circuit Creator', 38, barY + watermarkH / 2);

    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = isDark ? '#4a5568' : '#9aa0b8';
    const siteText = 'clairo.web.app';
    const textW = ctx.measureText(siteText).width;
    ctx.fillText(siteText, W - textW - 12, barY + watermarkH / 2);

    downloadCanvas(canvas);
  };
  logo.onerror = () => {
    // Draw fallback if logo fails to load
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.fillStyle = isDark ? '#8892a4' : '#5a6282';
    ctx.textBaseline = 'middle';
    ctx.fillText('⬡ Clairo Logic Circuit Creator', 12, barY + watermarkH / 2);

    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = isDark ? '#4a5568' : '#9aa0b8';
    const siteText = 'clairo.web.app';
    const textW = ctx.measureText(siteText).width;
    ctx.fillText(siteText, W - textW - 12, barY + watermarkH / 2);

    downloadCanvas(canvas);
  };
  logo.src = 'https://huggingface.co/datasets/MidoSTM11/Mido/resolve/main/Final%20Logo.png';
}

function downloadCanvas(canvas) {
  try {
    const link = document.createElement('a');
    link.download = 'circuit.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  } catch (err) {
    alert("Export failed due to browser CORS policies regarding the downloaded logo image. Wait a moment or check your privacy settings.");
  }
}

// ── Export helper: draw a gate on canvas ctx ─────────────
function drawExportGate(ctx, comp, cx, cy, P) {
  const w = GATE_W, h = GATE_H;
  const type = comp.type;

  ctx.save();
  ctx.translate(cx, cy);

  // Draw gate body path using canvas equivalent
  ctx.beginPath();
  const m = h / 2;
  switch (type) {
    case 'AND':
      ctx.moveTo(4, 4); ctx.lineTo(w*0.45, 4);
      ctx.quadraticCurveTo(w, 4, w, m);
      ctx.quadraticCurveTo(w, h-4, w*0.45, h-4);
      ctx.lineTo(4, h-4); ctx.closePath(); break;
    case 'NAND':
      ctx.moveTo(4, 4); ctx.lineTo(w*0.42, 4);
      ctx.quadraticCurveTo(w-10, 4, w-10, m);
      ctx.quadraticCurveTo(w-10, h-4, w*0.42, h-4);
      ctx.lineTo(4, h-4); ctx.closePath(); break;
    case 'OR':
      ctx.moveTo(4, 4); ctx.quadraticCurveTo(14, 4, w*0.5, 4);
      ctx.quadraticCurveTo(w+2, 4, w+2, m);
      ctx.quadraticCurveTo(w+2, h-4, w*0.5, h-4);
      ctx.quadraticCurveTo(14, h-4, 4, h-4);
      ctx.quadraticCurveTo(12, m, 4, 4); break;
    case 'NOR':
      ctx.moveTo(4, 4); ctx.quadraticCurveTo(14, 4, w*0.45, 4);
      ctx.quadraticCurveTo(w-8, 4, w-8, m);
      ctx.quadraticCurveTo(w-8, h-4, w*0.45, h-4);
      ctx.quadraticCurveTo(14, h-4, 4, h-4);
      ctx.quadraticCurveTo(12, m, 4, 4); break;
    case 'XOR':
      ctx.moveTo(8, 4); ctx.quadraticCurveTo(18, 4, w*0.5, 4);
      ctx.quadraticCurveTo(w+2, 4, w+2, m);
      ctx.quadraticCurveTo(w+2, h-4, w*0.5, h-4);
      ctx.quadraticCurveTo(18, h-4, 8, h-4);
      ctx.quadraticCurveTo(16, m, 8, 4); break;
    case 'XNOR':
      ctx.moveTo(8, 4); ctx.quadraticCurveTo(18, 4, w*0.45, 4);
      ctx.quadraticCurveTo(w-8, 4, w-8, m);
      ctx.quadraticCurveTo(w-8, h-4, w*0.45, h-4);
      ctx.quadraticCurveTo(18, h-4, 8, h-4);
      ctx.quadraticCurveTo(16, m, 8, 4); break;
    case 'NOT':
      ctx.moveTo(4, 4); ctx.lineTo(w-10, m); ctx.lineTo(4, h-4); ctx.closePath(); break;
    default:
      ctx.rect(4, 4, w-8, h-8);
  }
  ctx.fillStyle   = P.gateFill;
  ctx.strokeStyle = P.gateStroke;
  ctx.lineWidth   = 1.5;
  ctx.fill();
  ctx.stroke();

  // Bubble for NAND / NOR / NOT / XNOR
  if (['NAND','NOR','NOT','XNOR'].includes(type)) {
    const bx = type === 'NOT' ? w-7 : (type === 'NAND' ? w-7 : (type === 'NOR' ? w-5 : w-5));
    ctx.beginPath();
    ctx.arc(bx, m, 3, 0, Math.PI*2);
    ctx.fillStyle   = P.gateFill;
    ctx.strokeStyle = P.gateStroke;
    ctx.lineWidth   = 1.5;
    ctx.fill();
    ctx.stroke();
  }

  // Extra curve for XOR / XNOR
  if (type === 'XOR' || type === 'XNOR') {
    ctx.beginPath();
    ctx.moveTo(2, 4); ctx.quadraticCurveTo(9, m, 2, h-4);
    ctx.strokeStyle = P.gateStroke;
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  }

  // Gate label
  ctx.font         = 'bold 9px "JetBrains Mono", monospace';
  ctx.fillStyle    = P.textSec;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(type, w/2, m);

  // Input pin lines + circles
  const pins = Renderer.getGatePins(comp);
  pins.inputs.forEach(pin => {
    ctx.beginPath();
    ctx.arc(pin.x, pin.y, PIN_RADIUS, 0, Math.PI*2);
    ctx.fillStyle   = P.pinFill;
    ctx.strokeStyle = P.gateStroke;
    ctx.lineWidth   = 1.5;
    ctx.fill();
    ctx.stroke();
  });

  // Output pin circle
  const op = pins.output;
  ctx.beginPath();
  ctx.arc(op.x, op.y, PIN_RADIUS, 0, Math.PI*2);
  ctx.fillStyle   = comp.outputValue ? P.wireActive : P.wireInact;
  ctx.strokeStyle = P.gateStroke;
  ctx.lineWidth   = 1.5;
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

function drawExportInput(ctx, comp, cx, cy, P) {
  const w = INPUT_W, h = INPUT_H;
  const isOn = comp.value === 1;

  ctx.save();
  ctx.translate(cx, cy);

  // Box
  ctx.beginPath();
  roundRectPath(ctx, 0, 0, w, h, 6);
  ctx.fillStyle   = isOn ? P.greenDim : P.accentDim;
  ctx.strokeStyle = isOn ? P.green : P.accent;
  ctx.lineWidth   = 1.5;
  ctx.fill();
  ctx.stroke();

  // Label letter
  ctx.font         = 'bold 13px "JetBrains Mono", monospace';
  ctx.fillStyle    = isOn ? P.green : P.accent;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(comp.label || 'A', w * 0.38, h / 2);

  // Value
  ctx.font      = 'bold 11px "JetBrains Mono", monospace';
  ctx.fillStyle = isOn ? P.green : P.textDim;
  ctx.fillText(String(comp.value), w * 0.78, h / 2);

  // Output pin
  ctx.beginPath();
  ctx.arc(w, h/2, PIN_RADIUS, 0, Math.PI*2);
  ctx.fillStyle   = isOn ? P.wireActive : P.wireInact;
  ctx.strokeStyle = P.gateStroke;
  ctx.lineWidth   = 1.5;
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

function drawExportOutput(ctx, comp, cx, cy, P) {
  const r  = OUTPUT_R;
  const isOn = comp.outputValue === 1;

  ctx.save();
  ctx.translate(cx, cy);

  // Outer ring
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI*2);
  ctx.fillStyle   = P.gateFill;
  ctx.strokeStyle = isOn ? P.green : P.gateStroke;
  ctx.lineWidth   = 1.5;
  ctx.fill();
  ctx.stroke();

  // LED glow
  if (isOn) {
    ctx.beginPath();
    ctx.arc(r, r, r * 0.55, 0, Math.PI*2);
    ctx.shadowColor = P.green;
    ctx.shadowBlur  = 10;
    ctx.fillStyle   = P.green;
    ctx.fill();
    ctx.shadowBlur  = 0;
  } else {
    ctx.beginPath();
    ctx.arc(r, r, r * 0.55, 0, Math.PI*2);
    ctx.fillStyle = P.ledOff;
    ctx.fill();
  }

  // Label
  ctx.font         = 'bold 10px "JetBrains Mono", monospace';
  ctx.fillStyle    = isOn ? P.green : P.textDim;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  ctx.shadowBlur   = 0;
  ctx.fillText(comp.label || 'X', r, r * 2 + 4);

  // Input pin
  ctx.beginPath();
  ctx.arc(0, r, PIN_RADIUS, 0, Math.PI*2);
  ctx.fillStyle   = P.pinFill;
  ctx.strokeStyle = P.gateStroke;
  ctx.lineWidth   = 1.5;
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function exportJSON() {
  const data = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    components: State.components,
    wires: State.wires
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = 'circuit.json';
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      State.components = data.components || [];
      State.wires = data.wires ||[];
      State.selected.clear();

      // Update nodeCounter to avoid id collisions
      const maxId =[...State.components, ...State.wires]
        .map(x => parseInt(x.id.replace('n', '')) || 0)
        .reduce((a, b) => Math.max(a, b), 0);
      nodeCounter = maxId;

      State.pushHistory();
      if (State.simulating) LogicEngine.propagate(State);
      Renderer.render();
      fitToScreen();
    } catch {
      alert('Invalid JSON file');
    }
  };
  reader.readAsText(file);
}

/* ============================================================
   UTILITY FUNCTIONS
   ============================================================ */
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function bezierPath(x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1) * 0.5;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function getCircuitBounds() {
  if (!State.components.length) return { x: 0, y: 0, w: 400, h: 300 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  State.components.forEach(c => {
    const w = c.type === 'input' ? INPUT_W : (c.type === 'output' ? OUTPUT_R*2 : GATE_W);
    const h = c.type === 'input' ? INPUT_H : (c.type === 'output' ? OUTPUT_R*2 : GATE_H);
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + w);
    maxY = Math.max(maxY, c.y + h);
  });
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function setTool(tool) {
  State.tool = tool;
  document.getElementById('btn-select').classList.toggle('active', tool === 'select');
  document.getElementById('btn-wire').classList.toggle('active', tool === 'wire');
  const status = document.getElementById('status-mode');
  status.textContent = tool === 'wire' ? 'WIRE MODE' : 'SELECT MODE';
  const canvas = document.getElementById('main-canvas');
  canvas.classList.remove('cursor-crosshair', 'cursor-grab', 'cursor-grabbing');
  if (tool === 'wire') canvas.classList.add('cursor-crosshair');
}

function zoom(factor) {
  const svg = document.getElementById('main-canvas');
  const cx = svg.clientWidth / 2;
  const cy = svg.clientHeight / 2;
  const newScale = Math.max(0.15, Math.min(4, State.viewScale * factor));
  const ratio = newScale / State.viewScale;
  State.viewX = cx - ratio * (cx - State.viewX);
  State.viewY = cy - ratio * (cy - State.viewY);
  State.viewScale = newScale;
  Renderer.applyTransform();
  MiniMap.update();
}

function fitToScreen() {
  if (!State.components.length) return;
  const bounds = getCircuitBounds();
  const svg = document.getElementById('main-canvas');
  const pad = 80;
  const scaleX = (svg.clientWidth - pad*2) / bounds.w;
  const scaleY = (svg.clientHeight - pad*2) / bounds.h;
  State.viewScale = Math.max(0.15, Math.min(2, Math.min(scaleX, scaleY)));
  State.viewX = (svg.clientWidth - bounds.w * State.viewScale) / 2 - bounds.x * State.viewScale;
  State.viewY = (svg.clientHeight - bounds.h * State.viewScale) / 2 - bounds.y * State.viewScale;
  Renderer.applyTransform();
  MiniMap.update();
}

function toggleInputValue(id) {
  const comp = State.getComponent(id);
  if (!comp) return;
  comp.value = comp.value === 1 ? 0 : 1;
  State.pushHistory();
  if (State.simulating) LogicEngine.propagate(State);
  Renderer.render();
  PropertiesPanel.update();
}

function updateStatus() {
  document.getElementById('status-info').textContent =
    `${State.components.length} components • ${State.wires.length} wires`;
}

function playConnectSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.1);
  } catch (e) { /* audio not critical */ }
}

Renderer.updateStatus = updateStatus;

/* ============================================================
   DEMO CIRCUIT
   Loads a sample AND gate circuit on first run
   ============================================================ */
function loadDemoCircuit() {
  const aId = uid(), bId = uid(), andId = uid(), outId = uid();

  State.components =[
    { id: aId, type: 'input', x: 80, y: 100, value: 1, outputValue: 1, label: 'A' },
    { id: bId, type: 'input', x: 80, y: 200, value: 0, outputValue: 0, label: 'B' },
    { id: andId, type: 'AND', x: 240, y: 140, outputValue: 0 },
    { id: outId, type: 'output', x: 420, y: 190, outputValue: 0, label: 'X' }
  ];

  State.wires =[
    { id: uid(), fromId: aId, toId: andId, fromPin: 0, toPin: 0, active: false },
    { id: uid(), fromId: bId, toId: andId, fromPin: 0, toPin: 1, active: false },
    { id: uid(), fromId: andId, toId: outId, fromPin: 0, toPin: 0, active: false }
  ];

  State.pushHistory();
}

/* ============================================================
   AI LOGIC PARSER
   Uses Claude API to parse natural language logic into circuit
   ============================================================ */
const AIParser = {
  pendingCircuit: null,

  open() {
    const overlay = document.getElementById('ai-parser-overlay');
    overlay.classList.remove('ai-overlay-hidden');
    overlay.style.display = 'flex';
    setTimeout(() => document.getElementById('ai-logic-input').focus(), 100);
    this.hideStatus();
    this.hideResult();
  },

  close() {
    const overlay = document.getElementById('ai-parser-overlay');
    overlay.style.display = 'none';
    overlay.classList.add('ai-overlay-hidden');
    this.pendingCircuit = null;
  },

  showStatus(msg, type = 'loading') {
    const area = document.getElementById('ai-status-area');
    const content = document.getElementById('ai-status-content');
    area.classList.remove('ai-status-hidden');
    content.className = type;
    content.textContent = msg;
  },

  hideStatus() {
    document.getElementById('ai-status-area').classList.add('ai-status-hidden');
  },

  showResult(parsedExpr, circuit) {
    this.pendingCircuit = circuit;
    const area = document.getElementById('ai-result-area');
    const expr = document.getElementById('ai-parsed-expr');
    area.classList.remove('ai-result-hidden');
    expr.textContent = parsedExpr;
  },

  hideResult() {
    document.getElementById('ai-result-area').classList.add('ai-result-hidden');
    this.pendingCircuit = null;
  },

  async generate() {
    const input = document.getElementById('ai-logic-input').value.trim();
    if (!input) return;

    const btn = document.getElementById('ai-generate-btn');
    btn.disabled = true;
    this.hideResult();
    this.showStatus('Analyzing your logic expression…', 'loading');

    const systemPrompt = `You are a logic circuit compiler. Convert any logic expression or natural language description into a JSON circuit specification.

SUPPORTED GATE TYPES: AND, OR, NOT, NAND, NOR, XOR, XNOR

INPUT FORMATS you must handle:
- Formal: X = (A AND B) OR C
- Natural: "Output is 1 when A is 1 and B is 0"  
- Mixed: "X=1 if ((A AND NOT B) NAND C) XOR ((A AND C) OR B)"
- Symbolic: A & B | ~C, A * B + ~C
- Any combination of keywords: AND/and/&/*, OR/or/|/+, NOT/not/~/!, NAND/nand, NOR/nor, XOR/xor/^, XNOR/xnor

Rules:
- Variables like A, B, C, In1, myVar → all become input nodes
- The output variable (left side of =, or implied) becomes the output node
- Build a tree of gates for the expression
- Each intermediate sub-expression needs its own gate node
- All gates MUST have exactly 1 or 2 inputs (NOT takes 1, all others take exactly 2). For 3+ inputs, cascade multiple 2-input gates.

Return ONLY valid JSON (no markdown, no explanation) in this exact structure:
{
  "parsedExpression": "human-readable cleaned up version of the expression",
  "inputs":["A", "B", "C"],
  "output": "X",
  "gates":[
    {"id": "g1", "type": "NOT", "inputs": ["A"]},
    {"id": "g2", "type": "AND", "inputs": ["g1", "B"]},
    {"id": "g3", "type": "OR", "inputs": ["g2", "C"]}
  ],
  "outputFrom": "g3"
}

"inputs" array: names of all input variables used
"gates" array: each gate has id, type, and inputs (array of variable names or gate ids)
"outputFrom": id of the gate whose output feeds the final output node`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: systemPrompt,
          messages:[{ role: 'user', content: input }]
        })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      const text = data.content?.find(b => b.type === 'text')?.text || '';
      
      // Strip any markdown code fences
      const clean = text.replace(/```json|```/gi, '').trim();
      const circuit = JSON.parse(clean);

      this.hideStatus();
      this.showResult(circuit.parsedExpression, circuit);

    } catch (err) {
      console.error('AI Parse error:', err);
      this.hideStatus();
      this.showStatus(
        err.message.includes('JSON') 
          ? '⚠ Could not parse the AI response. Try rephrasing your expression.'
          : `⚠ ${err.message}`,
        'error'
      );
    }

    btn.disabled = false;
  },

  applyCircuit() {
    const circuit = this.pendingCircuit;
    if (!circuit) return;

    // Clear existing canvas
    State.components = [];
    State.wires =[];
    State.selected.clear();

    const idMap = {}; // varName or gateId → component id

    // Layout constants
    const colGap = 180;
    const rowGap = 90;
    const startX = 80;
    const canvasHeight = 500;

    // Place input nodes
    const inputs = circuit.inputs ||[];
    inputs.forEach((name, i) => {
      const id = uid();
      const y = (i * rowGap) + (canvasHeight / 2) - ((inputs.length - 1) * rowGap / 2);
      const comp = {
        id,
        type: 'input',
        x: startX,
        y: y - INPUT_H / 2,
        value: 1,
        outputValue: 1,
        label: name
      };
      State.components.push(comp);
      idMap[name] = id;
    });

    // Topological layout of gates: assign columns
    const gates = circuit.gates ||[];
    const gateDepth = {};

    function getDepth(gateId, visited = new Set()) {
      if (gateDepth[gateId] !== undefined) return gateDepth[gateId];
      if (visited.has(gateId)) return 0; // prevent cycle crash
      visited.add(gateId);
      
      const gate = gates.find(g => g.id === gateId);
      if (!gate) return 0;
      let maxDepth = 0;
      gate.inputs.forEach(inp => {
        if (gates.find(g => g.id === inp)) {
          maxDepth = Math.max(maxDepth, getDepth(inp, visited) + 1);
        }
      });
      gateDepth[gateId] = maxDepth;
      return maxDepth;
    }

    gates.forEach(g => getDepth(g.id));

    // Group gates by column depth
    const cols = {};
    gates.forEach(g => {
      const d = gateDepth[g.id] || 0;
      if (!cols[d]) cols[d] = [];
      cols[d].push(g);
    });

    const numCols = Object.keys(cols).length;

    // Place gates
    Object.entries(cols).forEach(([depth, gateList]) => {
      const col = parseInt(depth);
      const x = startX + INPUT_W + 40 + col * colGap;
      gateList.forEach((gate, i) => {
        const id = uid();
        const y = (i * rowGap) + (canvasHeight / 2) - ((gateList.length - 1) * rowGap / 2);
        const comp = {
          id,
          type: gate.type,
          x,
          y: y - GATE_H / 2,
          outputValue: 0
        };
        State.components.push(comp);
        idMap[gate.id] = id;
      });
    });

    // Place output node
    const outX = startX + INPUT_W + 40 + numCols * colGap + 40;
    const outId = uid();
    State.components.push({
      id: outId,
      type: 'output',
      x: outX,
      y: canvasHeight / 2 - OUTPUT_R,
      outputValue: 0,
      label: circuit.output || 'X'
    });

    // Create wires for gates
    gates.forEach(gate => {
      const toId = idMap[gate.id];
      if (!toId) return;
      gate.inputs.forEach((inp, pinIdx) => {
        const fromId = idMap[inp];
        if (!fromId) return;
        State.wires.push({
          id: uid(),
          fromId,
          toId,
          fromPin: 0,
          toPin: pinIdx, // Requires exactly 1 or 2 pins based on prompt enforcement
          active: false
        });
      });
    });

    // Wire final gate (or directly from an input) to output
    const finalGateId = idMap[circuit.outputFrom];
    if (finalGateId) {
      State.wires.push({
        id: uid(),
        fromId: finalGateId,
        toId: outId,
        fromPin: 0,
        toPin: 0,
        active: false
      });
    }

    State.pushHistory();
    State.simulating = true;
    document.getElementById('btn-simulate').classList.add('sim-active');
    document.getElementById('status-sim').textContent = '● SIM ON';
    document.getElementById('status-sim').className = 'sim-on';

    LogicEngine.propagate(State);
    Renderer.render();
    fitToScreen();

    this.close();
  },

  init() {
    // Open button
    document.getElementById('btn-ai-parse').addEventListener('click', () => this.open());

    // Close button
    document.getElementById('ai-close-btn').addEventListener('click', () => this.close());

    // Overlay click-outside
    document.getElementById('ai-parser-overlay').addEventListener('click', (e) => {
      if (e.target === document.getElementById('ai-parser-overlay')) this.close();
    });

    // Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('ai-parser-overlay').style.display === 'flex') {
        this.close();
      }
    });

    // Generate button
    document.getElementById('ai-generate-btn').addEventListener('click', () => this.generate());

    // Ctrl+Enter in textarea
    document.getElementById('ai-logic-input').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.generate();
      }
    });

    // Clear button
    document.getElementById('ai-clear-input').addEventListener('click', () => {
      document.getElementById('ai-logic-input').value = '';
      document.getElementById('ai-char-count').textContent = '0 / 500';
      this.hideStatus();
      this.hideResult();
    });

    // Char count
    document.getElementById('ai-logic-input').addEventListener('input', (e) => {
      const len = e.target.value.length;
      const counter = document.getElementById('ai-char-count');
      counter.textContent = `${len} / 500`;
      counter.style.color = len > 450 ? 'var(--orange)' : '';
      if (len > 500) e.target.value = e.target.value.slice(0, 500);
    });

    // Example chips
    document.querySelectorAll('.ai-example-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const expr = chip.dataset.expr;
        const textarea = document.getElementById('ai-logic-input');
        textarea.value = expr;
        const len = expr.length;
        document.getElementById('ai-char-count').textContent = `${len} / 500`;
        this.hideStatus();
        this.hideResult();
        textarea.focus();
      });
    });

    // Apply to canvas
    document.getElementById('ai-apply-btn').addEventListener('click', () => this.applyCircuit());

    // Cancel result
    document.getElementById('ai-cancel-build').addEventListener('click', () => {
      this.hideResult();
      this.hideStatus();
    });
  }
};

/* ============================================================
   APP BOOTSTRAP
   ============================================================ */
function App() {
  Renderer.init();
  MiniMap.init();
  InteractionManager.init();
  AIParser.init();

  loadDemoCircuit();
  LogicEngine.propagate(State);
  State.simulating = true;
  Renderer.render();
  fitToScreen();

  // Tool buttons
  document.getElementById('btn-select').addEventListener('click', () => setTool('select'));
  document.getElementById('btn-wire').addEventListener('click', () => setTool('wire'));

  document.getElementById('btn-undo').addEventListener('click', () => {
    if (State.undo()) { LogicEngine.propagate(State); Renderer.render(); PropertiesPanel.update(); }
  });
  document.getElementById('btn-redo').addEventListener('click', () => {
    if (State.redo()) { LogicEngine.propagate(State); Renderer.render(); PropertiesPanel.update(); }
  });
  document.getElementById('btn-delete').addEventListener('click', () => {
    State.removeSelected(); LogicEngine.propagate(State); Renderer.render(); PropertiesPanel.update();
  });
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (confirm('Clear all components and wires?')) {
      State.components = []; State.wires =[]; State.selected.clear();
      State.pushHistory(); Renderer.render(); PropertiesPanel.update();
    }
  });

  // Simulate toggle
  const simBtn = document.getElementById('btn-simulate');
  simBtn.addEventListener('click', () => {
    State.simulating = !State.simulating;
    simBtn.classList.toggle('sim-active', State.simulating);
    const statusSim = document.getElementById('status-sim');
    statusSim.textContent = State.simulating ? '● SIM ON' : '● SIM OFF';
    statusSim.className = State.simulating ? 'sim-on' : 'sim-off';
    if (State.simulating) LogicEngine.propagate(State);
    Renderer.render();
  });

  // Export
  document.getElementById('btn-export-png').addEventListener('click', exportPNG);
  document.getElementById('btn-export-json').addEventListener('click', exportJSON);
  document.getElementById('btn-import-json').addEventListener('click', () => {
    document.getElementById('file-import').click();
  });
  document.getElementById('file-import').addEventListener('change', e => {
    if (e.target.files[0]) { importJSON(e.target.files[0]); e.target.value = ''; }
  });

  // Zoom controls
  document.getElementById('btn-zoom-in').addEventListener('click', () => zoom(1.25));
  document.getElementById('btn-zoom-out').addEventListener('click', () => zoom(0.8));
  document.getElementById('btn-zoom-fit').addEventListener('click', fitToScreen);

  // Theme toggle
  const themeBtn = document.getElementById('btn-theme');
  themeBtn.addEventListener('click', () => {
    const isDark = document.documentElement.dataset.theme === 'dark';
    document.documentElement.dataset.theme = isDark ? 'light' : 'dark';
    document.getElementById('icon-sun').style.display = isDark ? 'block' : 'none';
    document.getElementById('icon-moon').style.display = isDark ? 'none' : 'block';
    Renderer.render();
    MiniMap.update();
  });

  // Context menu actions
  document.getElementById('ctx-delete').addEventListener('click', () => {
    if (ContextMenu.currentId) {
      State.selected.add(ContextMenu.currentId);
      State.removeSelected();
      LogicEngine.propagate(State);
      Renderer.render();
      PropertiesPanel.update();
    }
    ContextMenu.hide();
  });

  document.getElementById('ctx-duplicate').addEventListener('click', () => {
    if (ContextMenu.currentId) {
      const comp = State.getComponent(ContextMenu.currentId);
      if (comp) {
        const nc = { ...comp, id: uid(), x: comp.x + 40, y: comp.y + 40 };
        State.addComponent(nc);
        State.pushHistory();
        if (State.simulating) LogicEngine.propagate(State);
        Renderer.render();
      }
    }
    ContextMenu.hide();
  });

  document.getElementById('ctx-rename').addEventListener('click', () => {
    const id = ContextMenu.currentId;
    ContextMenu.hide();
    if (!id) return;
    const comp = State.getComponent(id);
    if (!comp || (!('label' in comp))) return;
    document.getElementById('modal-input').value = comp.label || '';
    document.getElementById('modal-overlay').classList.add('visible');
    document.getElementById('modal-input').focus();
    document.getElementById('modal-input').select();

    const confirm = () => {
      const val = document.getElementById('modal-input').value.trim();
      if (val) {
        comp.label = val.slice(0, 6);
        State.pushHistory();
        Renderer.render();
        PropertiesPanel.update();
      }
      document.getElementById('modal-overlay').classList.remove('visible');
    };

    document.getElementById('modal-confirm').onclick = confirm;
    document.getElementById('modal-input').onkeydown = e => { if (e.key === 'Enter') confirm(); };
  });

  document.getElementById('modal-cancel').addEventListener('click', () => {
    document.getElementById('modal-overlay').classList.remove('visible');
  });

  document.getElementById('ctx-properties').addEventListener('click', () => {
    if (ContextMenu.currentId) {
      State.selected.clear();
      State.selected.add(ContextMenu.currentId);
      Renderer.render();
      PropertiesPanel.update();
    }
    ContextMenu.hide();
  });

  // Initial tool state
  setTool('select');

  // Status sim initial
  document.getElementById('status-sim').textContent = '● SIM ON';
  document.getElementById('status-sim').className = 'sim-on';
  document.getElementById('btn-simulate').classList.add('sim-active');
}

// Start
document.addEventListener('DOMContentLoaded', App);
