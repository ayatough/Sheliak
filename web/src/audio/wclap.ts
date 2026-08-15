// A CLAP host for a plugin compiled to WebAssembly (a WCLAP).
//
// # What this file is
//
// CLAP is a C ABI: structs of function pointers, reached through pointers into
// the plugin's address space. When the plugin is a wasm module, that address
// space is a `WebAssembly.Memory` and those function pointers are indices into
// the module's function table. So hosting one means doing by hand what a C
// compiler does for a native host — laying out structs at byte offsets, and
// calling through `table.get(index)`.
//
// Everything the ABI decides lives here and only here (docs/workstreams.md §8:
// "do not spread CLAP structure assumptions across the codebase; keep them
// behind one module so a spec change is one file"). The offsets below are
// wasm32 layouts of the structs in `clap-sys`, and `wclap/src/layout.rs`
// asserts every one of them against the real Rust types at compile time — they
// are one file written twice, like `params.rs` and `params.ts`, and building
// the plugin is what checks the pair.
//
// # The two things a browser host has to solve that a native one does not
//
// **Memory.** The host cannot hand the plugin a pointer to host memory,
// because there is no such thing here: JavaScript objects have no address the
// plugin could read. Every struct the host builds is therefore written *into
// the plugin's own memory*, obtained from the module's exported `malloc`.
//
// **Callbacks.** The plugin calls the host through function pointers, and a JS
// function has no index in the module's table. `installCallbacks` fixes that:
// it builds a tiny wasm module whose only content is imports re-exported as
// functions, instantiates it with the JS callbacks, and puts the results into
// the plugin's table. That is why the draft requires the table to be exported
// and growable.

/** The layout of every CLAP struct this host touches, on wasm32. */
const L = {
  entry: { init: 12, deinit: 16, getFactory: 20 },
  factory: { count: 0, getDescriptor: 4, create: 8 },
  descriptor: {
    size: 48,
    id: 12,
    name: 16,
    vendor: 20,
    url: 24,
    manualUrl: 28,
    supportUrl: 32,
    version: 36,
    description: 40,
    features: 44,
  },
  plugin: {
    size: 48,
    desc: 0,
    pluginData: 4,
    init: 8,
    destroy: 12,
    activate: 16,
    deactivate: 20,
    startProcessing: 24,
    stopProcessing: 28,
    reset: 32,
    process: 36,
    getExtension: 40,
    onMainThread: 44,
  },
  host: {
    size: 48,
    hostData: 12,
    name: 16,
    vendor: 20,
    url: 24,
    version: 28,
    getExtension: 32,
    requestRestart: 36,
    requestProcess: 40,
    requestCallback: 44,
  },
  process: {
    size: 40,
    steadyTime: 0,
    framesCount: 8,
    transport: 12,
    audioInputs: 16,
    audioOutputs: 20,
    audioInputsCount: 24,
    audioOutputsCount: 28,
    inEvents: 32,
    outEvents: 36,
  },
  audioBuffer: { size: 24, data32: 0, data64: 4, channelCount: 8, latency: 12, constantMask: 16 },
  inputEvents: { size: 12, ctx: 0, count: 4, get: 8 },
  outputEvents: { size: 8, ctx: 0, tryPush: 4 },
  eventHeader: { size: 16, byteSize: 0, time: 4, spaceId: 8, type: 10, flags: 12 },
  paramValue: { size: 48, paramId: 16, cookie: 20, noteId: 24, portIndex: 28, channel: 30, key: 32, value: 40 },
  paramInfo: { size: 1320, id: 0, flags: 4, cookie: 8, name: 12, module: 268, min: 1296, max: 1304, default: 1312 },
  audioPortInfo: { size: 276, id: 0, name: 4, flags: 260, channelCount: 264, portType: 268, inPlacePair: 272 },
  audioPortsExt: { count: 0, get: 4 },
  paramsExt: { count: 0, getInfo: 4, getValue: 8, valueToText: 12, textToValue: 16, flush: 20 },
} as const;

const CLAP_NAME_SIZE = 256;
const CORE_EVENT_SPACE = 0;
const EVENT_PARAM_VALUE = 5;
const PARAM_IS_STEPPED = 1 << 0;
const PARAM_IS_ENUM = 1 << 16;
/** How many parameter changes one block may carry before they are dropped. */
const EVENT_CAPACITY = 256;

/** What a `clap_plugin_descriptor` says about itself. */
export interface WclapDescriptor {
  id: string;
  name: string;
  vendor: string;
  version: string;
  description: string;
  features: string[];
}

/** One entry of `clap_plugin_params`. */
export interface WclapParam {
  id: number;
  name: string;
  min: number;
  max: number;
  default: number;
  /** Whole numbers only. A `50%` written against one of these rounds. */
  stepped: boolean;
  /** Each step is a name rather than a quantity. */
  enumerated: boolean;
}

/** One entry of `clap_plugin_audio_ports`. */
export interface WclapPort {
  id: number;
  name: string;
  channels: number;
  main: boolean;
}

// --------------------------------------------------------------- trampolines

type ValueType = 'i32' | 'i64' | 'f32' | 'f64';

/** A host callback: what it looks like to wasm, and what it does. */
export interface HostCallback {
  params: ValueType[];
  result: ValueType | null;
  fn: (...args: number[]) => number | void;
}

const TYPE_CODE: Record<ValueType, number> = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

function vec(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

function name(s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)];
  return [...uleb(bytes.length), ...bytes];
}

/**
 * Puts JS functions into a wasm module's function table and returns their
 * indices, which is the only form a CLAP plugin can call them in.
 *
 * The bridge is a wasm module with no code in it at all: N imported functions,
 * re-exported. Importing a JS function makes it a wasm function; exporting it
 * again makes it a `funcref` this side can store. Signatures have to match
 * exactly — wasm checks them at `table.set`, not at the call, so a mismatch
 * here surfaces as a much less obvious trap later.
 */
export function installCallbacks(table: WebAssembly.Table, callbacks: HostCallback[]): number[] {
  const types = callbacks.map((cb) => [
    0x60,
    ...vec(cb.params.map((p) => [TYPE_CODE[p]])),
    ...vec(cb.result === null ? [] : [[TYPE_CODE[cb.result]]]),
  ]);
  const imports = callbacks.map((_, i) => [...name('h'), ...name(`f${i}`), 0x00, ...uleb(i)]);
  const exports = callbacks.map((_, i) => [...name(`f${i}`), 0x00, ...uleb(i)]);

  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(2, vec(imports)),
    ...section(7, vec(exports)),
  ]);

  const env: Record<string, WebAssembly.ImportValue> = {};
  callbacks.forEach((cb, i) => (env[`f${i}`] = cb.fn as WebAssembly.ImportValue));
  const bridge = new WebAssembly.Instance(new WebAssembly.Module(bytes), { h: env });

  const base = table.grow(callbacks.length);
  callbacks.forEach((_, i) => table.set(base + i, bridge.exports[`f${i}`] as WebAssembly.ExportValue));
  return callbacks.map((_, i) => base + i);
}

// ------------------------------------------------------------------- module

interface ModuleExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  clap_entry: WebAssembly.Global;
  __indirect_function_table: WebAssembly.Table;
}

/**
 * One instantiated `.wclap` module. A module can describe several plugins and
 * make several instances of each; this object owns the memory they share.
 */
export class WclapModule {
  readonly exports: ModuleExports;
  private view: DataView;
  private bytesView: Uint8Array;
  private readonly entry: number;
  private factoryPtr = 0;
  private readonly decoder = new TextDecoder();

  private constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports as unknown as ModuleExports;
    for (const required of ['memory', 'malloc', 'clap_entry', '__indirect_function_table'] as const) {
      if (this.exports[required] === undefined) {
        throw new Error(
          `not a WCLAP: the module does not export "${required}". A WCLAP exports its memory, ` +
            'a growable function table, `clap_entry` and `malloc` (docs/workstreams.md §8)',
        );
      }
    }
    const buffer = this.exports.memory.buffer;
    this.view = new DataView(buffer);
    this.bytesView = new Uint8Array(buffer);
    this.entry = Number(this.exports.clap_entry.value);
    const init = this.fn(this.entry + L.entry.init);
    // `init(plugin_path)`: there is no path in a browser, and the spec allows
    // any string; the empty one says so honestly.
    if (init !== null && init(this.str('')) === 0) {
      throw new Error('the plugin refused to initialise (clap_entry.init returned false)');
    }
  }

  /**
   * Compiles and instantiates a module, refusing one this host cannot run.
   *
   * A WCLAP may import its memory instead of exporting it, and that memory
   * must then be shared — a `SharedArrayBuffer`, which needs COOP/COEP, which
   * Sheliak does not set because it breaks embedding. Such a plugin is
   * rejected by name rather than by a failure deep inside instantiation.
   */
  static instantiate(bytes: BufferSource): WclapModule {
    const module = new WebAssembly.Module(bytes);
    const imports = WebAssembly.Module.imports(module);
    if (imports.length > 0) {
      const memory = imports.find((i) => i.kind === 'memory');
      if (memory) {
        throw new Error(
          'this plugin imports its memory, which the spec says must then be shared. A shared ' +
            'memory needs cross-origin isolation (COOP/COEP), which Sheliak does not use — ' +
            'a plugin that exports its own memory works here, one that imports it cannot',
        );
      }
      const list = imports.map((i) => `${i.module}.${i.name}`).join(', ');
      throw new Error(
        `this plugin needs imports Sheliak does not provide yet: ${list}. ` +
          'Only a module that imports nothing runs today (docs/workstreams.md §8)',
      );
    }
    return new WclapModule(new WebAssembly.Instance(module, {}));
  }

  // ------------------------------------------------------------- memory

  /** wasm memory growth detaches every view — re-make them when it happens. */
  private sync(): void {
    if (this.view.buffer !== this.exports.memory.buffer) {
      this.view = new DataView(this.exports.memory.buffer);
      this.bytesView = new Uint8Array(this.exports.memory.buffer);
    }
  }

  get memory(): DataView {
    this.sync();
    return this.view;
  }

  /** Reserves `size` bytes inside the plugin, zeroed. */
  alloc(size: number): number {
    const ptr = this.exports.malloc(size);
    if (ptr === 0) throw new Error(`the plugin could not allocate ${size} bytes`);
    this.sync();
    this.bytesView.fill(0, ptr, ptr + size);
    return ptr;
  }

  /** Writes a NUL-terminated string into the plugin and returns its address. */
  str(text: string): number {
    const bytes = new TextEncoder().encode(text);
    const ptr = this.alloc(bytes.length + 1);
    this.bytesView.set(bytes, ptr);
    return ptr;
  }

  /** Reads a NUL-terminated string, stopping at `limit` bytes. */
  readStr(ptr: number, limit = 4096): string {
    if (ptr === 0) return '';
    this.sync();
    let end = ptr;
    const stop = Math.min(ptr + limit, this.bytesView.length);
    while (end < stop && this.bytesView[end] !== 0) end++;
    return this.decoder.decode(this.bytesView.subarray(ptr, end));
  }

  /** The function a pointer-sized field points at, or null for a null one. */
  fn(at: number): ((...args: number[]) => number) | null {
    this.sync();
    const index = this.view.getUint32(at, true);
    if (index === 0) return null;
    return this.exports.__indirect_function_table.get(index) as (...args: number[]) => number;
  }

  private need(at: number, what: string): (...args: number[]) => number {
    const fn = this.fn(at);
    if (fn === null) throw new Error(`the plugin has no ${what}`);
    return fn;
  }

  // ------------------------------------------------------------ factory

  private factory(): number {
    if (this.factoryPtr !== 0) return this.factoryPtr;
    const getFactory = this.need(this.entry + L.entry.getFactory, 'clap_entry.get_factory');
    const ptr = getFactory(this.str('clap.plugin-factory'));
    if (ptr === 0) {
      throw new Error('the module has no plugin factory (clap.plugin-factory is not supported)');
    }
    this.factoryPtr = ptr;
    return ptr;
  }

  /** Every plugin this module offers, in factory order. */
  descriptors(): WclapDescriptor[] {
    const factory = this.factory();
    const count = this.need(factory + L.factory.count, 'a factory count')(factory);
    const get = this.need(factory + L.factory.getDescriptor, 'a factory descriptor');
    const out: WclapDescriptor[] = [];
    for (let i = 0; i < count; i++) {
      const ptr = get(factory, i);
      if (ptr === 0) continue;
      const features: string[] = [];
      let list = this.memory.getUint32(ptr + L.descriptor.features, true);
      while (list !== 0) {
        const item = this.memory.getUint32(list, true);
        if (item === 0) break;
        features.push(this.readStr(item, CLAP_NAME_SIZE));
        list += 4;
      }
      out.push({
        id: this.readStr(this.memory.getUint32(ptr + L.descriptor.id, true), CLAP_NAME_SIZE),
        name: this.readStr(this.memory.getUint32(ptr + L.descriptor.name, true), CLAP_NAME_SIZE),
        vendor: this.readStr(this.memory.getUint32(ptr + L.descriptor.vendor, true), CLAP_NAME_SIZE),
        version: this.readStr(this.memory.getUint32(ptr + L.descriptor.version, true), CLAP_NAME_SIZE),
        description: this.readStr(this.memory.getUint32(ptr + L.descriptor.description, true)),
        features,
      });
    }
    return out;
  }

  /** Creates one instance of the plugin with this id. */
  create(id: string): WclapPlugin {
    const factory = this.factory();
    const create = this.need(factory + L.factory.create, 'a factory create_plugin');
    const host = this.buildHost();
    const ptr = create(factory, host, this.str(id));
    if (ptr === 0) {
      const known = this.descriptors().map((d) => d.id);
      throw new Error(
        `this module has no plugin "${id}". It offers: ${known.length > 0 ? known.join(', ') : '(none)'}`,
      );
    }
    return new WclapPlugin(this, ptr);
  }

  /**
   * The `clap_host` the plugin is handed. Its four callbacks are the minimum
   * that lets a plugin ask questions during `init()` without trapping.
   */
  private buildHost(): number {
    const ptr = this.alloc(L.host.size);
    const view = this.memory;
    view.setUint32(ptr + 0, 1, true); // clap_version.major
    view.setUint32(ptr + 4, 2, true); // .minor
    view.setUint32(ptr + 8, 2, true); // .revision
    view.setUint32(ptr + L.host.name, this.str('Sheliak'), true);
    view.setUint32(ptr + L.host.vendor, this.str('Sheliak'), true);
    view.setUint32(ptr + L.host.url, this.str('https://github.com/ayatough/Sheliak'), true);
    view.setUint32(ptr + L.host.version, this.str('0.1.0'), true);

    const nop = { params: ['i32'] as ValueType[], result: null, fn: () => {} };
    const [getExtension, requestRestart, requestProcess, requestCallback] = installCallbacks(
      this.exports.__indirect_function_table,
      [
        // Sheliak offers no host extensions yet: a plugin asking for one gets
        // a null, which every extension is specified to tolerate.
        { params: ['i32', 'i32'], result: 'i32', fn: () => 0 },
        nop,
        nop,
        nop,
      ],
    );
    const after = this.memory;
    after.setUint32(ptr + L.host.getExtension, getExtension!, true);
    after.setUint32(ptr + L.host.requestRestart, requestRestart!, true);
    after.setUint32(ptr + L.host.requestProcess, requestProcess!, true);
    after.setUint32(ptr + L.host.requestCallback, requestCallback!, true);
    return ptr;
  }
}

// ------------------------------------------------------------------- plugin

/**
 * One live plugin instance.
 *
 * The order is CLAP's: `init` → `activate` → `startProcessing` → `process`…
 * `activate` is where every buffer is reserved, so nothing in `process`
 * allocates on either side of the boundary.
 */
export class WclapPlugin {
  private readonly m: WclapModule;
  private readonly ptr: number;
  private destroyed = false;
  private active = false;

  // Everything below is allocated by `activate` and is plain wasm addresses.
  private maxFrames = 0;
  private processPtr = 0;
  private inData = 0;
  private outData = 0;
  private eventArena = 0;
  private eventCount = 0;
  private inputsPtr = 0;
  private outputsPtr = 0;
  /** in L, in R, out L, out R — see `channel()`. */
  private views: Array<Float32Array | undefined> = [];

  constructor(module: WclapModule, ptr: number) {
    this.m = module;
    this.ptr = ptr;
    const init = this.m.fn(this.ptr + L.plugin.init);
    if (init !== null && init(this.ptr) === 0) {
      throw new Error('the plugin failed to initialise (plugin.init returned false)');
    }
  }

  /** What the plugin says it is. */
  descriptor(): WclapDescriptor {
    const desc = this.m.memory.getUint32(this.ptr + L.plugin.desc, true);
    const id = this.m.readStr(this.m.memory.getUint32(desc + L.descriptor.id, true), CLAP_NAME_SIZE);
    return this.m.descriptors().find((d) => d.id === id) ?? {
      id,
      name: id,
      vendor: '',
      version: '',
      description: '',
      features: [],
    };
  }

  private extension(id: string): number {
    const get = this.m.fn(this.ptr + L.plugin.getExtension);
    return get === null ? 0 : get(this.ptr, this.m.str(id));
  }

  /** The plugin's audio ports, which decide how it may be wired up. */
  ports(): { inputs: WclapPort[]; outputs: WclapPort[] } {
    const ext = this.extension('clap.audio-ports');
    if (ext === 0) return { inputs: [], outputs: [] };
    const count = this.m.fn(ext + L.audioPortsExt.count);
    const get = this.m.fn(ext + L.audioPortsExt.get);
    if (count === null || get === null) return { inputs: [], outputs: [] };

    const info = this.m.alloc(L.audioPortInfo.size);
    const side = (isInput: boolean): WclapPort[] => {
      const n = count(this.ptr, isInput ? 1 : 0);
      const out: WclapPort[] = [];
      for (let i = 0; i < n; i++) {
        if (get(this.ptr, i, isInput ? 1 : 0, info) === 0) continue;
        const view = this.m.memory;
        out.push({
          id: view.getUint32(info + L.audioPortInfo.id, true),
          name: this.m.readStr(info + L.audioPortInfo.name, CLAP_NAME_SIZE),
          channels: view.getUint32(info + L.audioPortInfo.channelCount, true),
          main: (view.getUint32(info + L.audioPortInfo.flags, true) & 1) !== 0,
        });
      }
      return out;
    };
    return { inputs: side(true), outputs: side(false) };
  }

  /** Every parameter the plugin declares, in its own order. */
  params(): WclapParam[] {
    const ext = this.extension('clap.params');
    if (ext === 0) return [];
    const count = this.m.fn(ext + L.paramsExt.count);
    const getInfo = this.m.fn(ext + L.paramsExt.getInfo);
    if (count === null || getInfo === null) return [];

    const info = this.m.alloc(L.paramInfo.size);
    const n = count(this.ptr);
    const out: WclapParam[] = [];
    for (let i = 0; i < n; i++) {
      if (getInfo(this.ptr, i, info) === 0) continue;
      const view = this.m.memory;
      const flags = view.getUint32(info + L.paramInfo.flags, true);
      out.push({
        id: view.getUint32(info + L.paramInfo.id, true),
        name: this.m.readStr(info + L.paramInfo.name, CLAP_NAME_SIZE),
        min: view.getFloat64(info + L.paramInfo.min, true),
        max: view.getFloat64(info + L.paramInfo.max, true),
        default: view.getFloat64(info + L.paramInfo.default, true),
        stepped: (flags & PARAM_IS_STEPPED) !== 0,
        enumerated: (flags & PARAM_IS_ENUM) !== 0,
      });
    }
    return out;
  }

  /** The plugin's current value for one parameter. */
  value(id: number): number | null {
    const ext = this.extension('clap.params');
    if (ext === 0) return null;
    const get = this.m.fn(ext + L.paramsExt.getValue);
    if (get === null) return null;
    const out = this.m.alloc(8);
    if (get(this.ptr, id, out) === 0) return null;
    return this.m.memory.getFloat64(out, true);
  }

  /**
   * How the plugin spells a value — "Fold", "0.30", "20000". This is the only
   * way to label a control Sheliak knows nothing about.
   */
  valueText(id: number, value: number): string | null {
    const ext = this.extension('clap.params');
    if (ext === 0) return null;
    const toText = this.m.fn(ext + L.paramsExt.valueToText);
    if (toText === null) return null;
    const buffer = this.m.alloc(CLAP_NAME_SIZE);
    if (toText(this.ptr, id, value, buffer, CLAP_NAME_SIZE) === 0) return null;
    return this.m.readStr(buffer, CLAP_NAME_SIZE);
  }

  /** Reserves every buffer the render path needs. Call before `process`. */
  activate(sampleRate: number, maxFrames: number): void {
    if (this.destroyed) throw new Error('this plugin has been destroyed');
    const activate = this.m.fn(this.ptr + L.plugin.activate);
    if (activate !== null && activate(this.ptr, sampleRate, 1, maxFrames) === 0) {
      throw new Error('the plugin refused to activate');
    }
    this.active = true;
    this.maxFrames = maxFrames;
    this.buildProcess(maxFrames);
    const start = this.m.fn(this.ptr + L.plugin.startProcessing);
    if (start !== null) start(this.ptr);
  }

  /**
   * Lays out `clap_process` and everything it points at, once.
   *
   * Two stereo buffers, two `clap_audio_buffer`s, the pointer arrays they use,
   * an event arena and the two event-list vtables — all inside the plugin's
   * memory, because that is the only memory it can read.
   */
  private buildProcess(maxFrames: number): void {
    const m = this.m;
    const channelBytes = maxFrames * 4;
    const inL = m.alloc(channelBytes);
    const inR = m.alloc(channelBytes);
    const outL = m.alloc(channelBytes);
    const outR = m.alloc(channelBytes);
    this.inData = m.alloc(8);
    this.outData = m.alloc(8);
    let view = m.memory;
    view.setUint32(this.inData, inL, true);
    view.setUint32(this.inData + 4, inR, true);
    view.setUint32(this.outData, outL, true);
    view.setUint32(this.outData + 4, outR, true);

    this.inputsPtr = m.alloc(L.audioBuffer.size);
    this.outputsPtr = m.alloc(L.audioBuffer.size);
    view = m.memory;
    for (const [buf, data] of [
      [this.inputsPtr, this.inData],
      [this.outputsPtr, this.outData],
    ] as const) {
      view.setUint32(buf + L.audioBuffer.data32, data, true);
      view.setUint32(buf + L.audioBuffer.channelCount, 2, true);
    }

    this.eventArena = m.alloc(EVENT_CAPACITY * L.paramValue.size);

    const inEvents = m.alloc(L.inputEvents.size);
    const outEvents = m.alloc(L.outputEvents.size);
    const [count, get, tryPush] = installCallbacks(m.exports.__indirect_function_table, [
      { params: ['i32'], result: 'i32', fn: () => this.eventCount },
      {
        params: ['i32', 'i32'],
        result: 'i32',
        fn: (_list, index) =>
          index! < this.eventCount ? this.eventArena + index! * L.paramValue.size : 0,
      },
      // Output events — a plugin reporting its own parameter changes. Nothing
      // reads them yet, and dropping them is legal; accepting them is not
      // optional, because a plugin may check the return value.
      { params: ['i32', 'i32'], result: 'i32', fn: () => 1 },
    ]);
    view = m.memory;
    view.setUint32(inEvents + L.inputEvents.count, count!, true);
    view.setUint32(inEvents + L.inputEvents.get, get!, true);
    view.setUint32(outEvents + L.outputEvents.tryPush, tryPush!, true);

    this.processPtr = m.alloc(L.process.size);
    view = m.memory;
    view.setBigInt64(this.processPtr + L.process.steadyTime, -1n, true);
    view.setUint32(this.processPtr + L.process.audioInputs, this.inputsPtr, true);
    view.setUint32(this.processPtr + L.process.audioOutputs, this.outputsPtr, true);
    view.setUint32(this.processPtr + L.process.audioInputsCount, 1, true);
    view.setUint32(this.processPtr + L.process.audioOutputsCount, 1, true);
    view.setUint32(this.processPtr + L.process.inEvents, inEvents, true);
    view.setUint32(this.processPtr + L.process.outEvents, outEvents, true);
  }

  /**
   * A writable view of one input channel — write the block here.
   *
   * Cached, and re-made only when the plugin's memory has grown underneath it:
   * this is called twice per render quantum on the audio thread, where a
   * fresh `Float32Array` per block would be garbage nobody asked for.
   */
  input(channel: 0 | 1): Float32Array {
    return this.channel(this.inData, channel);
  }

  /** A view of one output channel — read the block from here after `process`. */
  output(channel: 0 | 1): Float32Array {
    return this.channel(this.outData, channel);
  }

  private channel(table: number, index: 0 | 1): Float32Array {
    const buffer = this.m.exports.memory.buffer;
    const slot = (table === this.inData ? 0 : 2) + index;
    const cached = this.views[slot];
    if (cached !== undefined && cached.buffer === buffer) return cached;
    const ptr = this.m.memory.getUint32(table + index * 4, true);
    const view = new Float32Array(buffer, ptr, this.maxFrames);
    this.views[slot] = view;
    return view;
  }

  /**
   * Queues a parameter change for the next block. `time` is a frame offset
   * within that block, and CLAP requires events in ascending time order.
   *
   * Returns false when the block is already carrying `EVENT_CAPACITY`
   * changes — a caller that cares can slow down rather than lose one silently.
   */
  setParam(id: number, value: number, time = 0): boolean {
    if (this.eventCount >= EVENT_CAPACITY) return false;
    const at = this.eventArena + this.eventCount * L.paramValue.size;
    const view = this.m.memory;
    view.setUint32(at + L.eventHeader.byteSize, L.paramValue.size, true);
    view.setUint32(at + L.eventHeader.time, time, true);
    view.setUint16(at + L.eventHeader.spaceId, CORE_EVENT_SPACE, true);
    view.setUint16(at + L.eventHeader.type, EVENT_PARAM_VALUE, true);
    view.setUint32(at + L.eventHeader.flags, 0, true);
    view.setUint32(at + L.paramValue.paramId, id, true);
    view.setUint32(at + L.paramValue.cookie, 0, true);
    view.setInt32(at + L.paramValue.noteId, -1, true);
    view.setInt16(at + L.paramValue.portIndex, -1, true);
    view.setInt16(at + L.paramValue.channel, -1, true);
    view.setInt16(at + L.paramValue.key, -1, true);
    view.setFloat64(at + L.paramValue.value, value, true);
    this.eventCount++;
    return true;
  }

  /** Renders `frames` frames from the input views into the output views. */
  process(frames: number): void {
    if (!this.active) throw new Error('process() before activate()');
    if (frames > this.maxFrames) {
      throw new Error(`this block is ${frames} frames; the plugin was activated for ${this.maxFrames}`);
    }
    this.m.memory.setUint32(this.processPtr + L.process.framesCount, frames, true);
    const process = this.m.fn(this.ptr + L.plugin.process);
    if (process !== null) process(this.ptr, this.processPtr);
    this.eventCount = 0;
  }

  /** Clears the plugin's tails and filter memory. */
  reset(): void {
    const reset = this.m.fn(this.ptr + L.plugin.reset);
    if (reset !== null) reset(this.ptr);
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.active) {
      const stop = this.m.fn(this.ptr + L.plugin.stopProcessing);
      if (stop !== null) stop(this.ptr);
      const deactivate = this.m.fn(this.ptr + L.plugin.deactivate);
      if (deactivate !== null) deactivate(this.ptr);
      this.active = false;
    }
    const destroy = this.m.fn(this.ptr + L.plugin.destroy);
    if (destroy !== null) destroy(this.ptr);
    this.destroyed = true;
  }
}
