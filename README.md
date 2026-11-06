# Switcher Laundry for Homebridge

Homebridge plugin that watches a **Switcher Power Plug** and tells HomeKit when a washer or dryer finishes.

Apple Home does not show live watts. Eve can. This plugin listens to the same local Switcher status broadcasts and turns power changes into sensors Home can automate.

## What you get in Home

For each configured plug:

- **Done** — contact sensor that opens when a cycle finishes (use this for notifications)
- **Running** — occupancy sensor while the machine is drawing sustained power
- **Clear Done** — momentary switch to close the done sensor without waiting for the next cycle

## Install

```sh
sudo npm install -g homebridge-switcher-laundry
```

Until the package is on npm, install from GitHub:

```sh
sudo npm install -g github:mirimalulkasif/homebridge-switcher-laundry
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
          "identifier": "e4eaf6",
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

The plug must stay on the same LAN as Homebridge. No cloud login is required for reading wattage from Power Plug broadcasts.

## Notifications

In the Home app, create an automation:

- When **Washing Machine Done** opens → send a notification (and optionally announce on a HomePod)

## Development

```sh
npm install
npm test
```

`npm test` compiles TypeScript and runs cycle-detection and HomeKit registration tests without a physical Switcher.

## License

Apache-2.0
