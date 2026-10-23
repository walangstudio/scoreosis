#include <dmsdk/sdk.h>
#include <dmsdk/dlib/sslsocket.h>

#if !defined(DM_PLATFORM_HTML5)
// Defold 1.13.1's internal setter expects a NUL beyond the supplied length.
namespace dmSSLSocket { Result SetSslPublicKeys(const uint8_t* key, uint32_t keylen); }

static int Configure(lua_State* L)
{
    size_t size;
    const char* pem = luaL_checklstring(L, 1, &size);
    // Lua strings provide the extra NUL that the engine's file loader omits.
    bool ready = size > 0 && size <= 1024 * 1024
        && dmSSLSocket::SetSslPublicKeys(reinterpret_cast<const uint8_t*>(pem), static_cast<uint32_t>(size)) == dmSSLSocket::RESULT_OK;
    lua_pushboolean(L, ready);
    return 1;
}
#endif

static dmExtension::Result Initialize(dmExtension::Params* params)
{
#if !defined(DM_PLATFORM_HTML5)
    static const luaL_reg methods[] = {{"configure", Configure}, {0, 0}};
    luaL_register(params->m_L, "scoreosis_tls", methods);
    lua_pop(params->m_L, 1);
#endif
    return dmExtension::RESULT_OK;
}

DM_DECLARE_EXTENSION(ScoreosisTLS, "ScoreosisTLS", 0, 0, Initialize, 0, 0, 0)
