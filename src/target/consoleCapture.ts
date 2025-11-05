import each from 'licia/each';
import map from 'licia/map';
import trim from 'licia/trim';
import stackTrace from 'licia/stackTrace';
import isStr from 'licia/isStr';
import connector from '../../node_modules/chobitsu/dist/cjs/lib/connector';
import { getTimestamp } from '../../node_modules/chobitsu/dist/cjs/lib/util';
import * as objManager from '../../node_modules/chobitsu/dist/cjs/lib/objManager';
import * as RuntimeDomain from '../../node_modules/chobitsu/dist/cjs/domains/Runtime';

type ConsoleMethod =
  | 'log'
  | 'warn'
  | 'error'
  | 'info'
  | 'dir'
  | 'table'
  | 'group'
  | 'groupCollapsed'
  | 'groupEnd'
  | 'debug'
  | 'clear';

type ConsoleMethodType =
  | 'log'
  | 'warning'
  | 'error'
  | 'info'
  | 'dir'
  | 'table'
  | 'startGroup'
  | 'startGroupCollapsed'
  | 'endGroup'
  | 'debug'
  | 'clear';

type ConsoleMethodMap = Record<ConsoleMethod, ConsoleMethodType>;

const consoleMethodTypeMap: ConsoleMethodMap = {
  log: 'log',
  warn: 'warning',
  error: 'error',
  info: 'info',
  dir: 'dir',
  table: 'table',
  group: 'startGroup',
  groupCollapsed: 'startGroupCollapsed',
  groupEnd: 'endGroup',
  debug: 'debug',
  clear: 'clear',
};

const nativeConsole: Partial<Record<ConsoleMethod, (...args: any[]) => any>> = {};
const originalDescriptors: Partial<Record<ConsoleMethod, PropertyDescriptor | null>> = {};
const consoleTimestampByType: Record<string, number> = {};
const consoleCaptureStorageKey = '__pubinfo_console_capture__';
let captureConsolePreference: boolean | null = null;
let captureConsoleRuntime = true;

const consoleSupportsProxy = typeof Proxy === 'function';
const consolePatchedStore =
  typeof Map === 'function' ? new Map<ConsoleMethod, (...args: any[]) => any>() : null;
const consolePatchedFallback: Partial<Record<ConsoleMethod, (...args: any[]) => any>> = {};
const objectHasOwn = Object.prototype.hasOwnProperty;
const scheduleConsoleTrigger =
  typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (cb: () => void) => setTimeout(cb, 0);

const runtimePending: Array<() => void> = [];
let runtimeEnabled = false;

const runtimeDomain: any = RuntimeDomain;
const originalRuntimeEnable =
  runtimeDomain && typeof runtimeDomain.enable === 'function'
    ? runtimeDomain.enable.bind(runtimeDomain)
    : null;

if (originalRuntimeEnable) {
  runtimeDomain.enable = function patchedRuntimeEnable(this: unknown, ...args: any[]) {
    const result = originalRuntimeEnable.apply(this, args);
    runtimeEnabled = true;
    flushRuntimePending();
    return result;
  };
} else {
  runtimeEnabled = true;
}

let nativeCaptured = false;

function flushRuntimePending() {
  if (!runtimePending.length) {
    return;
  }
  while (runtimePending.length) {
    const task = runtimePending.shift();
    if (task) {
      task();
    }
  }
}

function hasPatched(method: ConsoleMethod): boolean {
  if (consolePatchedStore) {
    return consolePatchedStore.has(method);
  }
  return objectHasOwn.call(consolePatchedFallback, method);
}

function setPatched(method: ConsoleMethod, fn: (...args: any[]) => any): void {
  if (consolePatchedStore) {
    consolePatchedStore.set(method, fn);
  } else {
    consolePatchedFallback[method] = fn;
  }
}

function deletePatched(method: ConsoleMethod): void {
  if (consolePatchedStore) {
    consolePatchedStore.delete(method);
  } else {
    delete consolePatchedFallback[method];
  }
}

function looksLikeNative(fn: (...args: any[]) => any): boolean {
  try {
    return /\[native code\]/.test(Function.prototype.toString.call(fn));
  } catch {
    return false;
  }
}

function captureNativeConsole(): void {
  if (nativeCaptured) {
    return;
  }
  nativeCaptured = true;
  each(consoleMethodTypeMap, (_type, name) => {
    const method = name as ConsoleMethod;
    const descriptor = Object.getOwnPropertyDescriptor(console, method);
    const current = (console as any)[method];
    if (typeof current !== 'function') {
      return;
    }
    let nativeFn = current;
    let storedDescriptor: PropertyDescriptor | null = descriptor || null;
    if (descriptor && descriptor.configurable !== false) {
      const overridden = current;
      try {
        if (delete (console as any)[method]) {
          const candidate = (console as any)[method];
          if (typeof candidate === 'function' && looksLikeNative(candidate)) {
            nativeFn = candidate;
            storedDescriptor = null;
          } else {
            (console as any)[method] = overridden;
          }
        }
      } catch {
        (console as any)[method] = overridden;
      }
    } else if (objectHasOwn.call(console, method)) {
      storedDescriptor = descriptor || null;
    } else if (looksLikeNative(current)) {
      storedDescriptor = null;
    }
    nativeConsole[method] = nativeFn;
    originalDescriptors[method] = storedDescriptor;
  });
  restoreConsole();
}

function mapConsoleArgs(argList: any[]): any[] {
  const args = Array.prototype.slice.call(argList);
  return map(args, arg => objManager.wrap(arg, { generatePreview: true }));
}

function nextConsoleTimestamp(type: string): number {
  const now = getTimestamp();
  const previous = consoleTimestampByType[type] || 0;
  const timestamp = now <= previous ? previous + 0.001 : now;
  consoleTimestampByType[type] = timestamp;
  return timestamp;
}

function applyConsoleReflect(fn: (...args: any[]) => any, args: any[]): any {
  if (typeof Reflect === 'object' && typeof Reflect.apply === 'function') {
    return Reflect.apply(fn, console, args);
  }
  return fn.apply(console, args);
}

function getCallFrames(error?: any) {
  let callFrames: any[] = [];
  const callSites = error ? error.stack : stackTrace();
  if (isStr(callSites)) {
    callFrames = callSites.split('\n');
    if (!error) {
      callFrames.shift();
    }
    callFrames.shift();
    callFrames = map(callFrames, val => ({
      functionName: trim(val),
    }));
  } else if (callSites) {
    callSites.shift();
    callFrames = map(callSites, (callSite: any) => ({
      functionName: callSite.getFunctionName(),
      lineNumber: callSite.getLineNumber(),
      columnNumber: callSite.getColumnNumber(),
      url: callSite.getFileName(),
    }));
  }
  return callFrames;
}

function triggerRuntimeConsoleAPICalled(
  type: ConsoleMethodType,
  args: any[],
  timestamp: number
): void {
  const send = () =>
    connector.trigger('Runtime.consoleAPICalled', {
      type,
      args,
      stackTrace: {
        callFrames: type === 'error' || type === 'warning' ? getCallFrames() : [],
      },
      executionContextId: 1,
      timestamp,
    });

  if (runtimeEnabled) {
    send();
  } else {
    runtimePending.push(send);
  }
}

function applyLegacyCapture(method: ConsoleMethod, type: ConsoleMethodType): void {
  if (hasPatched(method)) {
    return;
  }
  const nativeFn = nativeConsole[method];
  if (typeof nativeFn !== 'function') {
    return;
  }
  const patchedFn = function legacyConsolePatched(this: unknown, ...args: any[]) {
    const payloadArgs = mapConsoleArgs(args);
    const timestamp = nextConsoleTimestamp(type);
    scheduleConsoleTrigger(() => {
      triggerRuntimeConsoleAPICalled(type, payloadArgs, timestamp);
    });
    return applyConsoleReflect(nativeFn, args);
  };
  patchedFn.toString = () => nativeFn.toString();
  try {
    Object.defineProperty(patchedFn, 'name', { value: nativeFn.name });
  } catch {
    /* istanbul ignore next */
  }
  (console as any)[method] = patchedFn;
  setPatched(method, patchedFn);
}

function applyProxyForMethod(method: ConsoleMethod, type: ConsoleMethodType): void {
  if (!consoleSupportsProxy || hasPatched(method)) {
    return;
  }
  const nativeFn = nativeConsole[method];
  if (typeof nativeFn !== 'function') {
    return;
  }
  const proxy = new Proxy(nativeFn, {
    apply(target, _thisArg, argList) {
      const argsArray = Array.prototype.slice.call(argList);
      const payloadArgs = mapConsoleArgs(argsArray);
      const timestamp = nextConsoleTimestamp(type);
      scheduleConsoleTrigger(() => {
        triggerRuntimeConsoleAPICalled(type, payloadArgs, timestamp);
      });
      return applyConsoleReflect(target, argsArray);
    },
  });
  try {
    Object.defineProperty(proxy, 'name', { value: nativeFn.name });
  } catch {
    /* istanbul ignore next */
  }
  proxy.toString = () => nativeFn.toString();
  (console as any)[method] = proxy;
  setPatched(method, proxy);
}

function applyProxyCapture(): void {
  each(consoleMethodTypeMap, (type, name) => {
    const method = name as ConsoleMethod;
    if (consoleSupportsProxy) {
      applyProxyForMethod(method, type);
    } else {
      applyLegacyCapture(method, type);
    }
  });
}

function restoreConsole(): void {
  each(consoleMethodTypeMap, (_type, name) => {
    const method = name as ConsoleMethod;
    if (!nativeConsole[method]) {
      return;
    }
    try {
      delete (console as any)[method];
    } catch {
      /* istanbul ignore next */
    }
    const descriptor = originalDescriptors[method];
    const nativeFn = nativeConsole[method];
    if (descriptor) {
      Object.defineProperty(console, method, {
        configurable: descriptor.configurable !== false,
        enumerable: descriptor.enumerable ?? false,
        writable: descriptor.writable ?? true,
        value: nativeFn,
      });
    } else if (nativeFn) {
      (console as any)[method] = nativeFn;
    }
    deletePatched(method);
  });
  Object.keys(consoleTimestampByType).forEach(key => delete consoleTimestampByType[key]);
}

function loadConsoleCapturePreference(): boolean | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const storage = window.localStorage;
    if (!storage) {
      return null;
    }
    const value = storage.getItem(consoleCaptureStorageKey);
    if (value === null) {
      return null;
    }
    return value === 'true';
  } catch {
    return null;
  }
}

function saveConsoleCapturePreference(value: boolean | null): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const storage = window.localStorage;
    if (!storage) {
      return;
    }
    if (value === null) {
      storage.removeItem(consoleCaptureStorageKey);
    } else {
      storage.setItem(consoleCaptureStorageKey, value ? 'true' : 'false');
    }
  } catch {
    /* istanbul ignore next */
  }
}

function applyConsoleCaptureState(enabled: boolean): void {
  captureConsoleRuntime = enabled;
  if (enabled) {
    captureNativeConsole();
    restoreConsole();
    applyProxyCapture();
  } else {
    restoreConsole();
  }
}

function setConsoleCapture(
  enabled: boolean,
  opts?: {
    persist?: boolean;
  }
): void {
  const persist = opts && 'persist' in opts ? opts.persist : undefined;
  if (persist === true) {
    captureConsolePreference = enabled;
    saveConsoleCapturePreference(captureConsolePreference);
  } else if (persist === false) {
    captureConsolePreference = null;
    saveConsoleCapturePreference(null);
  }
  applyConsoleCaptureState(enabled);
}

function resetConsoleCapture(): void {
  captureConsolePreference = null;
  saveConsoleCapturePreference(null);
  applyConsoleCaptureState(true);
}

function installConsoleCapture(): void {
  if (typeof window === 'undefined' || typeof console === 'undefined') {
    return;
  }

  const existingPatch = (window as any).__pubinfo_console_capture_patch__;
  if (existingPatch && typeof existingPatch.restoreConsole === 'function') {
    try {
      existingPatch.restoreConsole();
    } catch {
      /* istanbul ignore next */
    }
  }

  (window as any).__pubinfo_console_capture_patch__ = {
    restoreConsole,
    applyProxyCapture,
    setConsoleCapture,
    resetConsoleCapture,
  };

  const storedPreference = loadConsoleCapturePreference();
  if (storedPreference !== null) {
    captureConsolePreference = storedPreference;
  }

  const initialState =
    captureConsolePreference === null ? true : Boolean(captureConsolePreference);

  applyConsoleCaptureState(initialState);

  const global = (window as any).__pubinfoChromeDevtools || {};
  global.setConsoleCapture = setConsoleCapture;
  global.resetConsoleCapture = resetConsoleCapture;
  try {
    Object.defineProperty(global, 'captureConsolePreference', {
      get() {
        return captureConsolePreference;
      },
      configurable: true,
    });
    Object.defineProperty(global, 'captureConsoleRuntime', {
      get() {
        return captureConsoleRuntime;
      },
      configurable: true,
    });
  } catch {
    global.captureConsolePreference = captureConsolePreference;
    global.captureConsoleRuntime = captureConsoleRuntime;
  }
  (window as any).__pubinfoChromeDevtools = global;
}

installConsoleCapture();

export {};
