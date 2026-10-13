-- Defold bindings for scoreosis.client. The guest token lives in its own save
-- file so clearing game settings does not lose the online identity.
local M = {}

function M.platform(game_id)
	local path = sys.get_save_file("scoreosis", game_id .. ".token")
	return {
		request = function(url, method, headers, body, callback)
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
			sys.save(path, { token = token })
		end,
	}
end

M.now = socket.gettime

return M
