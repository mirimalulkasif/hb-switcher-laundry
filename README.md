# Switcher Laundry for Homebridge

Homebridge plugin that watches a **Switcher Power Plug** and tells HomeKit when a washer or dryer finishes.

Apple Home does not show live watts. Eve can — but Eve only mirrors HomeKit energy history and can go stale. This plugin reads the Switcher plug **directly** over your LAN (TCP status poll when `deviceId` + `deviceIp` are set, plus optional UDP) and turns power into sensors Home can automate.

If Eve freezes but the **Switcher app** still shows live watts, laundry TCP polling should still work. If the Switcher app is also stuck, fix Wi‑Fi / the plug first.

## What you get in Home

For each configured plug, Home shows **one device** (named like the washer/dryer):

- **Running** (occupancy, main tile) — on while the machine is drawing sustained power
- **Done** (contact) — opens when a cycle finishes and **stays open** until the next cycle starts or you clear it (use for notifications)
- **Empty Me** (optional switch) — turns **on** with Done; turn it **off** after you emptied the machine to clear Done

Open the device in Home to see Done / Empty Me (linked under Running).

## Install

```sh
sudo npm install -g homebridge-switcher-laundry
```

Until the package is on npm:

```sh
sudo npm install -g github:mirimalulkasif/hb-switcher-laundry
```

Restart Homebridge, then add **Switcher Laundry** from the Plugins page.

## Configuration

```json
{
  "platforms": [
    {
      "platform": "SwitcherLaundry",
      "name": "Switcher Laundry",
      "devices": [
        {
          "name": "Washing Machine",
          "identifier": "192.168.68.90",
          "deviceId": "e4eaf6",
          "startWatts": 5,
          "stopWatts": 2,
          "startSeconds": 60,
          "stopSeconds": 180
        }
      ]
    }
  ]
}
```

`identifier` can be the Switcher device id, a static IP, or the exact device name from the Switcher app.

### Washer + dryer (two plugs)

Add **two** entries under `devices` — one per Switcher plug. Each gets its own Done / Running / Clear Done sensors in Home.

v1.0.2+ shares one UDP listener across all laundry plugs. Older builds could only hear the first plug.

### Running next to homebridge-switcher-platform

Both plugins want Switcher UDP port **20002**. If Platform is already running, Laundry falls back to **TCP polling**.

**Every** laundry device should set (required when Switcher Platform is installed):

- **`deviceId`** — hex id from Switcher Platform logs (e.g. `Found New Switcher ... | ID:e4eaf6`)
- **`deviceIp`** — IP from those same logs
- **`deviceKey`** (optional) — copy `device_key` from Switcher Platform logs (e.g. `04`, `05`). If omitted, laundry learns it from UDP broadcasts (works next to Platform via `reuseAddr`) and reconnects when the real key arrives.

After restart you should see either `TCP connect … key=05` immediately, or `Learned device_key=05 … Reconnecting TCP`, then `TCP status ok … power_consumption`. Persistent timeouts mean wrong IP or the plug is unreachable on TCP **9957**.

### Calibrating thresholds

1. Run a normal wash with the plug connected.
2. Note idle watts (often near 0–2 W) and active watts in Eve or the Switcher app.
3. Set `startWatts` above idle noise and below normal running power.
4. Set `stopWatts` near idle.
5. Set `stopSeconds` longer than the longest low-power pause in the cycle (fill/rinse). Start around 3 minutes and raise it if “done” fires early.

## How detection works

1. Power stays at or above `startWatts` for `startSeconds` → **running**
2. After a real start, power stays at or below `stopWatts` for `stopSeconds` → **done**
3. The next sustained high-power stretch starts a new cycle and clears **done**

## Notifications

In the Home app, create an automation:

- When **Washing Machine Done** opens → send a notification (and optionally announce on a HomePod)

## Development

```sh
npm install
npm test
```

## License

Apache-2.0
