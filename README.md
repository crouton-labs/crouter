# crouter

## Install

```bash
npm install -g @crouton-kit/crouter
```

## Usage

```bash
crtr --help
```

## Official marketplace

`crtr` ships with the [crouter official marketplace](https://github.com/crouton-labs/crouter-official-marketplace) pre-installed. On first run it is cloned into your user scope and registered automatically — no plugins are enabled by default.

Browse and install plugins from it:

```bash
crtr pkg market inspect browse --marketplace crouter-official-marketplace
crtr pkg market manage install --marketplace crouter-official-marketplace --plugin <plugin>
```

To opt out of the bootstrap (e.g. in CI), set `CRTR_NO_BOOTSTRAP=1`.
