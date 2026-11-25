local sleep_timer = nil

local function set_sleep_until(ms)
  mp.set_property_number("user-data/quraa/sleep-until", ms)
end

local function cancel_timer()
  if sleep_timer ~= nil then
    sleep_timer:kill()
    sleep_timer = nil
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

set_sleep_until(0)
