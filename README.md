# LaServer

A simple LAS tile server in OCaml.


## Backend

Note much to note here currently. OCaml, using cohttp-eio.

## Frontend

This needs building before use using [deno](https://deno.com/).

```shell
cd frontend
deno task bundle
```

You can run the checker on the typescript, which currently fails as I slowly  migrate it from vanilla JS.

```shell
deno task check
```

## Running

```shell
dune exec -- laserver [path to COPC formatted LAZ files] ./fronted/dist/
```
