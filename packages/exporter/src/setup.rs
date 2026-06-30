use async_recursion::async_recursion;
use globset::{GlobBuilder, GlobMatcher};
use indicatif::{ProgressBar, ProgressStyle};
use regex::Regex;
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::{collections::HashSet, env};
use std::{error::Error, time::UNIX_EPOCH};
use tokio::process::Command;

macro_rules! get_env_var {
    ($name:expr) => {
        env::var($name).map_err(|_| format!("{} env variable is missing", $name))
    };
}

#[derive(Deserialize)]
struct Info {
    // name: String,
    version: String,
    // title: String,
    // author: String,
    // contact: String,
    // homepage: String,
    // dependencies: Vec<String>,
}

async fn get_info(path: &Path) -> Result<Info, Box<dyn Error>> {
    let contents = tokio::fs::read_to_string(path).await?;
    let p: Info = serde_json::from_str(&contents)?;
    Ok(p)
}

// Retained for reference only — no longer called. POT padding was a browser-WebGL1 requirement
// (REPEAT-wrap + mipmaps need power-of-two textures); our headless render path doesn't use it, and it
// was the cause of the 8192² compression OOM. See the call site in compress_next_img.
#[allow(dead_code)]
#[allow(clippy::needless_lifetimes)]
async fn make_img_pow2<'a>(
    path: &'a Path,
    tmp_dir: &Path,
) -> Result<Cow<'a, Path>, Box<dyn Error>> {
    let (w, h) = image::image_dimensions(path)?;
    let w_log = f32::log2(w as f32);
    let h_log = f32::log2(h as f32);

    if w_log.fract() != 0.0 || h_log.fract() != 0.0 {
        let mut file = tokio::fs::File::open(path).await?;
        let len = file.metadata().await?.len();
        let mut buffer = Vec::with_capacity(len as usize);
        use tokio::io::AsyncReadExt;
        file.read_to_end(&mut buffer).await?;
        let format = image::guess_format(&buffer)?;
        let mut out = image::DynamicImage::new_rgba8(
            u32::pow(2, f32::ceil(w_log) as u32),
            u32::pow(2, f32::ceil(h_log) as u32),
        );
        let img = image::load_from_memory_with_format(&buffer, format)?;
        image::imageops::replace(&mut out, &img, 0, 0);
        buffer.clear();
        let mut buffer = std::io::Cursor::new(buffer);
        out.write_to(&mut buffer, format)?;

        let tmp_path = tmp_dir.join(path);
        tokio::fs::create_dir_all(tmp_path.parent().unwrap()).await?;
        tokio::fs::write(&tmp_path, &buffer.into_inner()).await?;
        Ok(Cow::Owned(tmp_path))
    } else {
        Ok(Cow::Borrowed(path))
    }
}

async fn content_to_lines(path: &Path) -> Result<String, Box<dyn Error>> {
    let file = tokio::fs::File::open(path).await?;
    let buf = tokio::io::BufReader::new(file);
    use tokio::io::AsyncBufReadExt;
    let mut lines_stream = buf.lines();

    let mut content = String::new();
    let mut group = String::new();
    while let Some(line) = lines_stream.next_line().await? {
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') {
            group = line[1..line.len() - 1].to_string();
            continue;
        }
        let Some(idx) = line.find('=') else { continue };
        let sep = match group.len() {
            0 => "",
            _ => ".",
        };
        let val = line[idx + 1..].to_string().replace("'", r"\'");
        let subgroup = &line[..idx];

        use std::fmt::Write;
        write!(&mut content, "['{group}{sep}{subgroup}']='{val}',")?;
    }

    Ok(content)
}

#[async_recursion]
async fn glob(
    path: &Path,
    matcher: &GlobMatcher,
) -> Result<Vec<std::path::PathBuf>, Box<dyn Error>> {
    let mut entries = tokio::fs::read_dir(path).await?;
    let mut paths = Vec::<std::path::PathBuf>::new();

    while let Some(entry) = entries.next_entry().await? {
        let file_type = entry.file_type().await?;
        let entry_path = entry.path();
        if file_type.is_file() && matcher.is_match(&entry_path) {
            paths.push(entry_path.clone())
        } else if file_type.is_dir() {
            let mut inner_paths = glob(&entry_path, matcher).await?;
            paths.append(&mut inner_paths);
        }
    }

    Ok(paths)
}

async fn generate_locale(factorio_data: &PathBuf) -> Result<String, Box<dyn Error>> {
    let matcher = GlobBuilder::new("**/*/locale/en/*.cfg")
        .literal_separator(true)
        .build()?
        .compile_matcher();
    let paths = glob(factorio_data, &matcher).await?;
    let content = futures::future::try_join_all(paths.iter().map(|path| content_to_lines(&path)))
        .await?
        .concat();
    Ok(format!("return {{{}}}", content))
}

pub async fn extract(output_dir: &Path, base_factorio_dir: &Path) -> Result<(), Box<dyn Error>> {
    let factorio_data = base_factorio_dir.join("data");
    let mod_dir = base_factorio_dir.join("mods/export-data");
    let scenario_dir = mod_dir.join("scenarios/export-data");
    let extracted_data_path = base_factorio_dir.join("script-output/data.json");
    let factorio_executable = base_factorio_dir.join("bin/x64/factorio");

    let info = include_str!("export-data/info.json");
    let script = include_str!("export-data/control.lua");
    let data = include_str!("export-data/data-final-fixes.lua");
    let locale = generate_locale(&factorio_data).await?;

    tokio::fs::create_dir_all(&scenario_dir).await?;
    tokio::fs::write(mod_dir.join("info.json"), info).await?;
    tokio::fs::write(mod_dir.join("locale.lua"), locale).await?;
    tokio::fs::write(mod_dir.join("data-final-fixes.lua"), data).await?;
    tokio::fs::write(scenario_dir.join("control.lua"), script).await?;

    println!("Generating defines.lua");

    // The exit STATUS is intentionally not checked: the export-data scenario writes data.json
    // and then calls `error("!EXIT!")` to tear down the headless server, so Factorio always
    // exits NON-ZERO on a successful export. Success is therefore gated on data.json existing
    // (the read below), not on the exit code. `.await?` still propagates a real spawn/wait I/O
    // error. If the read fails, Factorio's own `factorio-current.log` has the cause (the
    // container entrypoint dumps it on early exit).
    Command::new(factorio_executable)
        .args(&["--start-server-load-scenario", "export-data/export-data"])
        .stdout(std::process::Stdio::null())
        .spawn()?
        .wait()
        .await?;

    let content = tokio::fs::read_to_string(&extracted_data_path).await?;
    tokio::fs::create_dir_all(&output_dir).await?;
    tokio::fs::write(output_dir.join("data.json"), &content).await?;

    let metadata_path = output_dir.join("metadata.json");

    let res = tokio::fs::read_to_string(&metadata_path).await;
    let old_metadata: HashMap<String, (u64, u64)> = match res {
        Ok(buffer) => serde_json::from_str(&buffer)?,
        Err(e) => match e.kind() {
            std::io::ErrorKind::NotFound => HashMap::new(),
            _ => return Err(Box::new(e)),
        },
    };
    let new_metadata = Arc::new(Mutex::new(HashMap::new()));

    lazy_static! {
        static ref IMG_REGEX: Regex = Regex::new(r#""([^"]+?\.png)""#).unwrap();
        // A Factorio mod namespace (`__base__`, `__core__`, `__space-age__`,
        // `__quality__`, `__recycler__`, `__elevated-rails__`, ...) maps to a
        // sibling directory under `data/` named after the mod. Upstream only
        // rewrote `__base__`/`__core__`; Space Age (2.1.x, and 2.0.x Space Age)
        // references DLC mod namespaces too, so rewrite them all generically.
        // Anchored to the LEADING `__mod__/` only (a namespace is always the
        // path prefix) so an incidental mid-path `__x__` segment is left intact,
        // and the class allows uppercase since mod internal names legally do
        // (e.g. `Krastorio2`).
        static ref MOD_NS_REGEX: Regex = Regex::new(r"^__([A-Za-z0-9_-]+)__/").unwrap();
    }
    let file_paths: HashSet<String> = IMG_REGEX
        .captures_iter(&content)
        .map(|cap| cap[1].to_string())
        .collect();

    let file_paths = file_paths
        .into_iter()
        .map(|s| {
            // Source sprite lives under data/<mod>/... (un-namespaced on disk);
            // the atlas output keeps the `__mod__/...` namespace so the render
            // side's identity lookup (`<path>.png -> /data/<path>.basis`) resolves.
            let in_path = factorio_data.join(MOD_NS_REGEX.replace(&s, "$1/").as_ref());
            let out_path = output_dir.join(s.replace(".png", ".basis").as_str());
            (in_path, out_path)
        })
        .collect::<Vec<(PathBuf, PathBuf)>>();

    let progress = ProgressBar::new(file_paths.len() as u64);
    progress.set_style(
        ProgressStyle::default_bar()
            .template("{wide_bar} {pos}/{len} ({elapsed})")
            .unwrap(),
    );

    let file_paths = Arc::new(Mutex::new(file_paths));

    let tmp_dir = std::env::temp_dir().join("__FBE__");
    tokio::fs::create_dir_all(&tmp_dir).await?;

    // Concurrent sprite-compression jobs. Each basisu job on a large (8192²-padded) sprite holds a
    // ~268 MB working set, so unbounded host-CPU parallelism can exhaust container memory and have
    // basisu silently fail on some sprites. Cap at EXPORT_MAX_JOBS (the container entrypoint derives
    // a memory-safe value) so the bound travels with the image instead of an operator `--cpus` flag.
    // Default = host parallelism for local/non-container runs; an explicit value is min'd with the
    // host count so it never oversubscribes cores.
    let host_parallelism = std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
    let max_jobs = std::env::var("EXPORT_MAX_JOBS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .map_or(host_parallelism, |n| n.min(host_parallelism));

    futures::future::try_join_all((0..max_jobs).map(|_| {
        compress_next_img(
            file_paths.clone(),
            &tmp_dir,
            progress.clone(),
            &old_metadata,
            new_metadata.clone(),
        )
    }))
    .await?;

    let new_metadata = {
        let new_metadata = new_metadata.lock().unwrap();
        serde_json::to_vec(&*new_metadata)?
    };
    tokio::fs::write(metadata_path, new_metadata).await?;

    progress.finish();

    tokio::fs::remove_dir_all(&tmp_dir).await?;
    println!("DONE!");

    Ok(())
}

async fn get_len_and_mtime(path: &Path) -> Result<(u64, u64), Box<dyn Error>> {
    let file = tokio::fs::File::open(path).await?;
    let metadata = file.metadata().await?;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_secs())
        .unwrap_or(0);
    Ok((metadata.len(), mtime))
}

async fn compress_next_img(
    file_paths: Arc<Mutex<Vec<(PathBuf, PathBuf)>>>,
    _tmp_dir: &Path,
    progress: ProgressBar,
    old_metadata: &HashMap<String, (u64, u64)>,
    new_metadata: Arc<Mutex<HashMap<String, (u64, u64)>>>,
) -> Result<(), Box<dyn Error>> {
    let get_paths = || file_paths.lock().unwrap().pop();
    while let Some((in_path, out_path)) = get_paths() {
        let (len, mtime) = get_len_and_mtime(&in_path).await?;
        let key = in_path.to_str().ok_or("PathBuf to &str failed")?;

        if old_metadata.get(key) == Some(&(len, mtime)) {
            new_metadata
                .lock()
                .unwrap()
                .insert(key.to_string(), (len, mtime));
        } else {
            // NPOT padding removed: basisu handles non-pow2 natively (it does its own 4-pixel block
            // padding internally), and our HEADLESS renderer never uses REPEAT-wrap/mipmaps on sprites
            // (that was a browser-WebGL1 requirement — `Editor.init` is never run headless). So the old
            // make_img_pow2 pad-to-next-POT (e.g. 4608x6144 -> 8192x8192, a 268 MB buffer) was pure dead
            // weight and the source of the compression OOM. Feed basisu the native sprite directly.
            let path: &Path = &in_path;

            tokio::fs::create_dir_all(out_path.parent().unwrap()).await?;

            let basisu_executable = "./basisu";
            let status = Command::new(basisu_executable)
                // .args(&["-comp_level", "2"])
                .args(&["-no_multithreading"])
                // .args(&["-ktx2"])
                .args(&["-mipmap"])
                .args(&["-file", path.to_str().ok_or("PathBuf to &str failed")?])
                .args(&[
                    "-output_file",
                    out_path.to_str().ok_or("PathBuf to &str failed")?,
                ])
                .stdout(std::process::Stdio::null())
                .spawn()?
                .wait()
                .await?;

            if status.success() {
                new_metadata
                    .lock()
                    .unwrap()
                    .insert(key.to_string(), (len, mtime));
            } else {
                progress.println(format!("FAILED: {:?}", path));
            }
        }

        progress.inc(1);
    }

    Ok(())
}

// TODO: look into using https://wiki.factorio.com/Download_API
pub async fn download_factorio(
    data_dir: &Path,
    base_factorio_dir: &Path,
    factorio_version: &str,
) -> Result<(), Box<dyn Error>> {
    let info_path = base_factorio_dir.join("data/base/info.json");

    let same_version = get_info(&info_path)
        .await
        .map(|info| info.version == factorio_version)
        .unwrap_or(false);

    if same_version {
        println!("Downloaded Factorio version matches required version");
    } else {
        println!("Downloading Factorio v{}", factorio_version);
        if data_dir.is_dir() {
            tokio::fs::remove_dir_all(data_dir).await?;
        }
        tokio::fs::create_dir_all(data_dir).await?;

        let username = get_env_var!("FACTORIO_USERNAME")?;
        let token = get_env_var!("FACTORIO_TOKEN")?;

        download(factorio_version, &username, &token, data_dir).await?;
    }

    Ok(())
}

async fn download(
    version: &str,
    username: &str,
    token: &str,
    out_dir: &Path,
) -> Result<(), Box<dyn Error>> {
    let os = match std::env::consts::OS {
        "linux" => "linux64",
        "windows" => "win64-manual",
        // "macos" => "osx",
        _ => panic!("unsupported OS"),
    };
    let url = format!("https://www.factorio.com/get-download/{version}/alpha/{os}?username={username}&token={token}");

    let client = reqwest::Client::new();
    let res = client.get(&url).send().await?;

    if !res.status().is_success() {
        panic!("Status code was not successful");
    }

    let pb = ProgressBar::new(0);

    let content_length = res.content_length();

    if let Some(content_length) = content_length {
        pb.set_length(content_length);
        pb.set_style(
            ProgressStyle::default_bar()
                .template("[{elapsed_precise}] [{bar:40.cyan/blue}] {bytes}/{total_bytes} ({eta})")
                .unwrap()
                .progress_chars("=> "),
        );
    } else {
        pb.set_style(ProgressStyle::default_spinner());
    }

    use futures::stream::TryStreamExt;
    let stream = res
        .bytes_stream()
        .map_err(|e| futures::io::Error::new(futures::io::ErrorKind::Other, e));

    let stream = stream.inspect_ok(|chunk| {
        pb.inc(chunk.len() as u64);
    });

    #[cfg(target_os = "windows")]
    {
        let mut bytes = if let Some(content_length) = content_length {
            Vec::with_capacity(content_length.try_into()?)
        } else {
            Vec::new()
        };
        let mut stream = stream;
        while let Some(chunk) = stream.try_next().await? {
            bytes.extend(chunk);
        }
        let mut ar = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
        ar.extract(out_dir)?;
    }
    #[cfg(target_os = "linux")]
    {
        let stream_reader = tokio_util::io::StreamReader::new(stream);
        let decompressor = async_compression::tokio::bufread::LzmaDecoder::new(stream_reader);

        let mut ar = tokio_tar::Archive::new(decompressor);
        ar.unpack(out_dir).await?;
    }

    pb.finish();

    Ok(())
}
