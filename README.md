# Switcher Laundry for Homebridge

Homebridge plugin that watches a **Switcher Power Plug** and tells HomeKit when a washer or dryer finishes.

Apple Home does not show live watts. Eve can. This plugin reads Switcher wattage (UDP broadcast, or TCP poll if UDP is busy) and turns power changes into sensors Home can automate.

## What you get in Home

For each configured plug:

- **Done** — contact sensor that opens when a cycle finishes (use this for notifications)
- **Running** — occupancy sensor while the machine is drawing sustained power
- **Clear Done** — momentary switch to close the done sensor without waiting for the next cycle

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

### Running next to homebridge-switcher-platform

Both plugins want Switcher UDP port **20002**. If Platform is already running, Laundry cannot listen and will fall back to **TCP polling**.

For that fallback, set **`deviceId`** (hex id from Switcher Platform logs, e.g. `Found New Switcher ... | ID:e4eaf6`). If `identifier` is not the IP, also set **`deviceIp`**.

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
