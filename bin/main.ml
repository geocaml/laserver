type tile = { path : Eio.Fs.dir_ty Eio.Path.t; info : Oclas.Las.t }

let ( let* ) = Result.bind

(* For the rtree we avoid storing complex data in there so we don't need to have
a Repr of anything other than basic types. *)

module RTile = struct
  type t = { name : string; bounds : Rtree.Rectangle.t }

  let t =
    let open Repr in
    record "tile" (fun name bounds -> { name; bounds })
    |+ field "name" string (fun t -> t.name)
    |+ field "bounds" Rtree.Rectangle.t (fun t -> t.bounds)
    |> sealr

  let n t = t.name

  type envelope = Rtree.Rectangle.t

  let envelope t = t.bounds
end

module R = Rtree.Make (Rtree.Rectangle) (RTile)

type state = { tile_map : (string * tile) list; rtree : R.t }

let build_state tile_list =
  let tile_map =
    List.map
      (fun tile ->
        let _, name = Option.get (Eio.Path.split tile.path) in
        (name, tile))
      tile_list
  in
  let rtiles =
    List.map
      (fun (name, tile) ->
        let header = Oclas.Las.header tile.info in
        let (x0, y0, _), (x1, y1, _) = Oclas.Header.bounds header in
        let bounds = Rtree.Rectangle.v ~x0 ~y0 ~x1 ~y1 in
        RTile.{ name; bounds })
      tile_map
  in
  let rtree = R.load rtiles in
  { tile_map; rtree }

let find_las_files sw dir_path =
  Eio.Path.read_dir dir_path
  |> List.filter (String.ends_with ~suffix:".laz")
  |> List.filter_map (fun name ->
      let path = Eio.Path.(dir_path / name) in
      let flow = Eio.Path.open_in ~sw path in
      let buf = Eio.Buf_read.of_flow flow ~max_size:1_000_000 in
      let info = Oclas.Las.of_buffer buf in
      match info with Ok info -> Some { path; info } | Error _ -> None)

let tiles_to_json tile_map =
  `List
    (List.map
       (fun (name, tile) ->
         let header = Oclas.Las.header tile.info in
         let (x0, y0, z0), (x1, y1, z1) = Oclas.Header.bounds header in
         `Assoc
           [
             ("name", `String name);
             ("point_count", `Int (Oclas.Header.number_of_point_records header));
             ( "bounds",
               `Assoc
                 [
                   ( "min",
                     `Assoc
                       [ ("x", `Float x0); ("y", `Float y0); ("z", `Float z0) ]
                   );
                   ( "max",
                     `Assoc
                       [ ("x", `Float x1); ("y", `Float y1); ("z", `Float z1) ]
                   );
                 ] );
           ])
       tile_map)
  |> Yojson.Safe.to_string

let get_float_query uri name =
  match Uri.get_query_param uri name with
  | None -> Error "Missing query"
  | Some x -> (
      match Float.of_string_opt x with
      | None -> Error "Invalid float"
      | Some x -> Ok x)

let get_point_query state req =
  let uri = Uri.of_string (Http.Request.resource req) in
  let* x = get_float_query uri "x" in
  let* y = get_float_query uri "y" in
  let envelope = Rtree.Rectangle.v ~x0:x ~y0:y ~x1:(x +. 1.) ~y1:(y +. 1.) in
  let keys = R.find state.rtree envelope in
  (* so inefficient *)
  let tiles =
    List.map
      (fun rtile ->
        let key = RTile.n rtile in
        (key, List.assoc key state.tile_map))
      keys
  in
  Ok tiles


let render_index state _req =
  let body = tiles_to_json state.tile_map in
  Cohttp_eio.Server.respond_string ~status:`OK ~body ()

let render_find state req =
  let open Cohttp_eio in
  match get_point_query state req with
  | Error str -> Server.respond_string ~status:`Not_acceptable ~body:str ()
  | Ok tiles ->
      let body = tiles_to_json tiles in
      Server.respond_string ~status:`OK ~body ()

let render_static_file path _state _req =
    ()

let handler routes state _socket req _body =
  let open Cohttp_eio in
  let uri = Uri.of_string (Http.Request.resource req) in
  let path = Uri.path uri in

  match Http.Request.meth req with
  | `GET -> (
    match List.assoc_opt path routes with
    | Some handler -> handler state req
    | None -> Server.respond_string ~status:`Not_found ~body:"Not found\n" ()
  )
  | _ -> Server.respond_string ~status:`Not_found ~body:"Not found\n" ()

let log_error ex = Printf.eprintf "Server error: %s\n%!" (Printexc.to_string ex)

let laserver env sw path =
  let arg_path =
    if Filename.is_relative path then Eio.Path.(env#cwd / path)
    else Eio.Path.(env#fs / path)
  in
  let dir = Eio.Path.open_dir ~sw arg_path in
  let tiles = find_las_files sw dir in
  let state = build_state tiles in

  let fixed_routes = [
    ("/",  render_index);
    ("/find", render_find)
  ] in

  let static_routes = List.map (fun (name, tile) ->
    ("/tile/" ^ name, render_static_file tile.path)
  ) state.tile_map in

  let routes = fixed_routes @ static_routes in

  let socket =
    Eio.Net.listen env#net ~sw ~backlog:128 ~reuse_addr:true
      (`Tcp (Eio.Net.Ipaddr.V4.loopback, 8080))
  in
  Printf.printf "Listening on http://localhost:8080\n%!";
  Cohttp_eio.Server.run socket ~on_error:log_error
    (Cohttp_eio.Server.make ~callback:(handler routes state) ())

let () =
  Eio_main.run @@ fun env ->
  Eio.Switch.run @@ fun sw ->
  match Array.to_list Sys.argv with
  | [ _; path ] -> laserver env sw path
  | _ -> Printf.eprintf "Usage: %s <directory>\n" Sys.argv.(0)
