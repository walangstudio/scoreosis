-- Defold bindings for scoreosis.client. The guest token lives in its own save
-- file so clearing game settings does not lose the online identity.
local M = {}
local tls_ready

function M.platform(game_id)
	local path = sys.get_save_file("scoreosis", game_id .. ".token")
	local web = sys.get_sys_info().system_name == "HTML5"
	if not web and tls_ready == nil then
		tls_ready = false
		if scoreosis_tls then
			local pem = sys.load_resource("/scoreosis/cacert.pem")
			tls_ready = pem and scoreosis_tls.configure(pem) or false
		end
	end
	local ready = web or tls_ready
	return {
		allow_http = sys.get_engine_info().is_debug,
		request = function(url, method, headers, body, callback)
			if not ready and url:match("^https://") then
				callback(0, json.encode({error = {code = "tls_unavailable", message = "Certificate verification unavailable"}}))
				return
			end
			http.request(url, method, function(_, _, response)
				callback(response.status or 0, response.response)
			end, headers, body, { timeout = 10 })
		end,
		encode = json.encode,
		decode = json.decode,
		load_token = function()
			local saved = sys.load(path)
			return type(saved.token) == "string" and saved.token or nil
		end,
		save_token = function(token)
			local saved = sys.load(path)
			saved.token = token
			sys.save(path, saved)
		end,
		load_entries = function()
			local saved = sys.load(path)
			return type(saved.entries) == "table" and saved.entries or {}
		end,
		save_entries = function(entries)
			local saved = sys.load(path)
			saved.entries = entries
			return sys.save(path, saved)
		end,
	}
end

M.now = socket.gettime

return M
