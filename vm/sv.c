/* Scoreosis verifier VM: a sandboxed Lua 5.1 state driven from JavaScript.
   Any Lua error aborts the whole Wasm call through host_abort; the host
   discards the instance and restores from a checkpoint. */
#include <stdlib.h>
#include <string.h>
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"

__attribute__((import_module("env"), import_name("host_abort")))
void host_abort(const char *msg, size_t len);

static lua_State *L;
static size_t mem_used, mem_limit;
static double budget_left, soft_left;
static const char *result;
static size_t result_len;

#define HOOK_INTERVAL 1000

static void *sv_lua_alloc(void *ud, void *ptr, size_t osize, size_t nsize) {
  (void)ud;
  if (nsize == 0) {
    free(ptr);
    mem_used -= osize;
    return NULL;
  }
  if (nsize > osize && mem_used + (nsize - osize) > mem_limit) return NULL;
  void *p = realloc(ptr, nsize);
  if (p) mem_used = mem_used - osize + nsize;
  return p;
}

void sv_throw(lua_State *s) {
  size_t len = 0;
  const char *msg = lua_isstring(s, -1) ? lua_tolstring(s, -1, &len) : NULL;
  if (!msg) {
    msg = "non-string Lua error";
    len = strlen(msg);
  }
  host_abort(msg, len);
  abort();
}

static int sv_panic(lua_State *s) {
  sv_throw(s);
  return 0;
}

static void sv_hook(lua_State *s, lua_Debug *ar) {
  (void)ar;
  budget_left -= HOOK_INTERVAL;
  soft_left -= HOOK_INTERVAL;
  if (budget_left < 0) luaL_error(s, "instruction budget exceeded");
}

/* Lets the driver stop between ticks once the caller's soft budget is spent. */
static int sv_soft_exhausted(lua_State *s) {
  lua_pushboolean(s, soft_left < 0);
  return 1;
}

static void open_lib(const char *name, lua_CFunction fn) {
  lua_pushcfunction(L, fn);
  lua_pushstring(L, name);
  lua_call(L, 1, 0);
}

static void remove_field(const char *table, const char *field) {
  if (table) lua_getglobal(L, table);
  else lua_pushvalue(L, LUA_GLOBALSINDEX);
  lua_pushnil(L);
  lua_setfield(L, -2, field);
  lua_pop(L, 1);
}

__attribute__((export_name("sv_malloc"))) void *sv_malloc(size_t n) { return malloc(n); }
__attribute__((export_name("sv_free"))) void sv_free(void *p) { free(p); }
__attribute__((export_name("sv_result_ptr"))) const char *sv_result_ptr(void) { return result; }
__attribute__((export_name("sv_result_len"))) size_t sv_result_len(void) { return result_len; }
__attribute__((export_name("sv_mem_used"))) size_t sv_mem_used(void) { return mem_used; }
__attribute__((export_name("sv_soft_left"))) double sv_soft_left(void) { return soft_left; }

__attribute__((export_name("sv_open"))) int sv_open(size_t limit) {
  static const char *const unsafe_base[] = {
    "dofile", "loadfile", "load", "loadstring", "require", "module",
    "getfenv", "setfenv", "newproxy", "collectgarbage", "print", "gcinfo", NULL,
  };
  static const char *const unsafe_math[] = {
    "random", "randomseed", "sin", "cos", "tan", "asin", "acos", "atan",
    "atan2", "exp", "log", "log10", "pow", "sinh", "cosh", "tanh", NULL,
  };
  if (L) return 1;
  mem_used = 0;
  mem_limit = limit;
  L = lua_newstate(sv_lua_alloc, NULL);
  if (!L) return 2;
  lua_atpanic(L, sv_panic);
  open_lib("", luaopen_base);
  open_lib(LUA_TABLIBNAME, luaopen_table);
  open_lib(LUA_STRLIBNAME, luaopen_string);
  open_lib(LUA_MATHLIBNAME, luaopen_math);
  for (int i = 0; unsafe_base[i]; i++) remove_field(NULL, unsafe_base[i]);
  for (int i = 0; unsafe_math[i]; i++) remove_field("math", unsafe_math[i]);
  remove_field("string", "dump");
  remove_field(NULL, "_G");
  lua_newtable(L);
  lua_setfield(L, LUA_REGISTRYINDEX, "sv_modules");
  lua_sethook(L, sv_hook, LUA_MASKCOUNT, HOOK_INTERVAL);
  budget_left = 0;
  return 0;
}

/* Compiles trusted source text and stores the chunk as a module loader. */
__attribute__((export_name("sv_module"))) void sv_module(const char *name, size_t name_len,
                                                          const char *src, size_t src_len) {
  if (src_len > 0 && src[0] == LUA_SIGNATURE[0]) {
    lua_pushliteral(L, "binary chunks are not accepted");
    sv_throw(L);
  }
  lua_getfield(L, LUA_REGISTRYINDEX, "sv_modules");
  lua_pushlstring(L, name, name_len);
  char chunk[96];
  size_t n = name_len < 80 ? name_len : 80;
  memcpy(chunk, "=", 1);
  memcpy(chunk + 1, name, n);
  chunk[n + 1] = 0;
  if (luaL_loadbuffer(L, src, src_len, chunk) != 0) sv_throw(L);
  lua_rawset(L, -3);
  lua_pop(L, 1);
}

static int sv_require(lua_State *s) {
  const char *name = luaL_checkstring(s, 1);
  lua_getfield(s, LUA_REGISTRYINDEX, "sv_loaded");
  if (lua_isnil(s, -1)) {
    lua_pop(s, 1);
    lua_newtable(s);
    lua_pushvalue(s, -1);
    lua_setfield(s, LUA_REGISTRYINDEX, "sv_loaded");
  }
  lua_getfield(s, -1, name);
  if (!lua_isnil(s, -1)) return 1;
  lua_pop(s, 1);
  lua_getfield(s, LUA_REGISTRYINDEX, "sv_modules");
  lua_getfield(s, -1, name);
  if (lua_isnil(s, -1)) return luaL_error(s, "module '%s' not found", name);
  lua_pushstring(s, name);
  lua_call(s, 1, 1);
  if (lua_isnil(s, -1)) {
    lua_pop(s, 1);
    lua_pushboolean(s, 1);
  }
  lua_pushvalue(s, -1);
  lua_setfield(s, -4, name);
  return 1;
}

/* Calls global `fn(arg)` and keeps its string result for the host. */
__attribute__((export_name("sv_call"))) void sv_call(const char *fn, size_t fn_len, const char *arg,
                                                      size_t arg_len, double budget, double soft) {
  budget_left = budget;
  soft_left = soft;
  lua_settop(L, 0);
  lua_pushlstring(L, fn, fn_len);
  lua_rawget(L, LUA_GLOBALSINDEX);
  if (!lua_isfunction(L, -1)) luaL_error(L, "no such entry point");
  lua_pushlstring(L, arg, arg_len);
  lua_call(L, 1, 1);
  result = lua_tolstring(L, -1, &result_len);
  if (!result) {
    result = "";
    result_len = 0;
  }
}

__attribute__((export_name("sv_install_require"))) void sv_install_require(void) {
  lua_pushcfunction(L, sv_require);
  lua_setglobal(L, "require");
  lua_pushcfunction(L, sv_soft_exhausted);
  lua_setglobal(L, "sv_soft_exhausted");
}
