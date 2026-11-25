local sleep_timer = nil
local mpris_job = nil

local function set_sleep_until(ms)
  mp.set_property_number("user-data/quraa/sleep-until", ms)
end

local function cancel_timer()
  if sleep_timer ~= nil then
    sleep_timer:kill()
    sleep_timer = nil
  end
end

local function stop_mpris_bridge()
  if mpris_job ~= nil then
    mp.abort_async_command(mpris_job)
    mpris_job = nil
  end
end

mp.register_script_message("quraa-sleep", function(raw_seconds)
  local seconds = tonumber(raw_seconds)
  cancel_timer()

  if not seconds or seconds <= 0 then
    set_sleep_until(0)
    return
  end

  local until_ms = (os.time() * 1000) + math.floor(seconds * 1000)
  set_sleep_until(until_ms)

  sleep_timer = mp.add_timeout(seconds, function()
    sleep_timer = nil
    set_sleep_until(0)
    mp.command("quit")
  end)
end)

mp.register_event("shutdown", function()
  cancel_timer()
  stop_mpris_bridge()
end)

local bridge_path = mp.get_opt("quraa_mpris_bridge")
if bridge_path and bridge_path ~= "" then
  local ipc_path = mp.get_opt("quraa_ipc") or mp.get_property("input-ipc-server") or ""
  local assets_dir = mp.get_opt("quraa_assets") or ""
  local config_dir = mp.get_opt("quraa_config") or ""
  local cli_path = mp.get_opt("quraa_cli") or ""
  local bus_name = mp.get_opt("quraa_mpris_name") or ""
  if ipc_path ~= "" then
    mpris_job = mp.command_native_async({
      name = "subprocess",
      playback_only = false,
      args = { "python3", bridge_path, ipc_path, assets_dir, config_dir, cli_path, bus_name },
    }, function()
      mpris_job = nil
    end)
  end
end

set_sleep_until(0)
