/** Thrown when Lua code fails. The instance that threw is unusable afterwards. */
export class VmError extends Error {
  override name = 'VmError';
}

export type VmLimits = {
  /** Lua heap bytes. */
  memory: number;
  /** Lua VM instructions per call, counted in steps of 1000. */
  instructions: number;
};

export type VmOptions = {
  wasm: WebAssembly.Module;
  driver: string;
  modules: Record<string, string>;
  limits: VmLimits;
};

type Exports = {
  memory: WebAssembly.Memory;
  _initialize(): void;
  sv_malloc(n: number): number;
  sv_free(p: number): void;
  sv_open(limit: number): number;
  sv_module(name: number, nameLen: number, src: number, srcLen: number): void;
  sv_install_require(): void;
  sv_call(
    fn: number,
    fnLen: number,
    arg: number,
    argLen: number,
    budget: number,
    soft: number,
  ): void;
  sv_result_ptr(): number;
  sv_result_len(): number;
  sv_mem_used(): number;
  sv_soft_left(): number;
};

type Buffer = { ptr: number; len: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENOSYS = 52;
const EBADF = 8;

/**
 * One sandboxed Lua 5.1 state with trusted modules loaded. Single-threaded and
 * not reentrant. After any VmError the instance refuses further calls.
 */
export class LuaVm {
  private readonly exports: Exports;
  private readonly limits: VmLimits;
  private broken = false;
  private lastSoft = 0;

  private constructor(exports: Exports, limits: VmLimits) {
    this.exports = exports;
    this.limits = limits;
  }

  static async create(options: VmOptions): Promise<LuaVm> {
    let vm: LuaVm | undefined;
    const wasi = new Proxy(
      { fd_prestat_get: () => EBADF },
      { get: (target, key) => (target as Record<string | symbol, unknown>)[key] ?? (() => ENOSYS) },
    );
    const instance = await WebAssembly.instantiate(options.wasm, {
      wasi_snapshot_preview1: wasi,
      env: {
        host_abort(ptr: number, len: number) {
          if (!vm) throw new VmError('lua aborted during startup');
          vm.broken = true;
          throw new VmError(readString(vm.exports, ptr, len));
        },
      },
    });
    const exports = instance.exports as unknown as Exports;
    vm = new LuaVm(exports, options.limits);
    exports._initialize();
    if (exports.sv_open(options.limits.memory) !== 0)
      throw new VmError('lua state allocation failed');
    const modules = { ...options.modules, 'scoreosis.driver': options.driver };
    for (const [name, source] of Object.entries(modules)) {
      vm.withStrings([name, source], ([n, s]) => exports.sv_module(n.ptr, n.len, s.ptr, s.len));
    }
    exports.sv_install_require();
    vm.call('require', 'scoreosis.driver');
    return vm;
  }

  /**
   * Calls a global Lua function with one string argument and returns its string result.
   * `soft` caps instructions for code that checks `sv_soft_exhausted()` and stops early.
   */
  call(fn: string, arg = '', soft = this.limits.instructions): string {
    this.lastSoft = soft;
    return this.withStrings([fn, arg], ([f, a]) => {
      this.exports.sv_call(f.ptr, f.len, a.ptr, a.len, this.limits.instructions, soft);
      return readString(this.exports, this.exports.sv_result_ptr(), this.exports.sv_result_len());
    });
  }

  /** Instructions the last call used, rounded up to the hook interval of 1000. */
  lastInstructions(): number {
    return this.lastSoft - this.exports.sv_soft_left();
  }

  memoryUsed(): number {
    return this.exports.sv_mem_used();
  }

  private withStrings<T>(values: [string, string], fn: (buffers: [Buffer, Buffer]) => T): T {
    if (this.broken) throw new VmError('vm is unusable after an earlier error');
    const buffers = values.map((v) => {
      const bytes = encoder.encode(v);
      const ptr = this.exports.sv_malloc(Math.max(1, bytes.length));
      if (ptr === 0) throw new VmError('wasm allocation failed');
      new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
      return { ptr, len: bytes.length };
    }) as [Buffer, Buffer];
    try {
      return fn(buffers);
    } finally {
      if (!this.broken) for (const b of buffers) this.exports.sv_free(b.ptr);
    }
  }
}

function readString(exports: Exports, ptr: number, len: number): string {
  return decoder.decode(new Uint8Array(exports.memory.buffer, ptr, len));
}
