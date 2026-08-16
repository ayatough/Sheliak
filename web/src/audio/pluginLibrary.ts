// The plugins this build can show a panel for, on the main thread.
//
// The worklet has its own instances — it has to, they are what makes sound —
// and they are unreachable from here: a plugin lives inside a
// `WebAssembly.Memory` on the audio thread, and there is no way to ask it a
// question from the main thread except by not doing that. So the panel gets its
// own copy of each module, created but **never activated**: a plugin that is not
// activated allocates nothing beyond its parameter block, which is what makes
// this cheap enough to do for a panel.
//
// It exists at all because a panel needs what only the plugin knows — the
// parameter names, their ranges, and its own spelling of a value.

import { WclapModule, type WclapPlugin } from './wclap.ts';

/** One plugin, ready to be asked about itself. */
export interface LibraryEntry {
  id: string;
  name: string;
  plugin: WclapPlugin;
}

export class PluginLibrary {
  private readonly modules: WclapModule[] = [];
  private readonly instances = new Map<string, WclapPlugin>();
  private loading: Promise<void> | null = null;
  /** Why a bundle could not be loaded, if that happened. */
  readonly problems: string[] = [];

  constructor(private readonly urls: readonly string[]) {}

  /**
   * Fetches and instantiates every bundle, once. Safe to call on every
   * recompile; the work happens the first time and the promise is shared.
   */
  load(): Promise<void> {
    this.loading ??= this.fetchAll();
    return this.loading;
  }

  private async fetchAll(): Promise<void> {
    for (const url of this.urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.modules.push(WclapModule.instantiate(await res.arrayBuffer()));
      } catch (error) {
        this.problems.push(`${url}: ${(error as Error).message}`);
      }
    }
  }

  /** Every plugin id this build carries, in factory order. */
  ids(): string[] {
    return this.modules.flatMap((module) => module.descriptors().map((d) => d.id));
  }

  /**
   * A plugin to ask about itself, created on first use and kept. Null for an id
   * this build does not carry — a `.clap` on the machine, most likely, which
   * the browser cannot open at all.
   */
  get(id: string): WclapPlugin | null {
    const existing = this.instances.get(id);
    if (existing) return existing;
    const module = this.modules.find((m) => m.descriptors().some((d) => d.id === id));
    if (module === undefined) return null;
    try {
      const plugin = module.create(id);
      this.instances.set(id, plugin);
      return plugin;
    } catch {
      return null;
    }
  }
}
