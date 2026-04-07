import * as fsp from "fs/promises"
import * as fs from "fs"
import * as path from "path"
import { runScript, runProcess } from "./process-utils.js"
import { getFactorioPlayerDataPath, getWindowsAppData, toFactorioPath } from "./factorio-process.js"
import { CliError } from "./cli-error.js"

const MIN_FACTORIO_TEST_VERSION = "3.0.0"

// Mods that ship with the Space Age DLC — present in every Factorio installation
// that has the DLC, but never downloaded from the mod portal.
// They form a single cohesive group: enabling one requires enabling all of them.
export const BUILTIN_MODS = new Set(["base", "quality", "elevated-rails", "space-age"])

type Version = [number, number, number]

function parseVersion(version: string): Version {
  const parts = version.split(".").map(Number)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = parseVersion(a)
  const [bMajor, bMinor, bPatch] = parseVersion(b)
  if (aMajor !== bMajor) return aMajor - bMajor
  if (aMinor !== bMinor) return aMinor - bMinor
  return aPatch - bPatch
}

export async function configureModToTest(
  modsDir: string,
  modPath?: string,
  modName?: string,
  verbose?: boolean,
): Promise<string> {
  if (modPath) {
    if (verbose) console.log("Copying mod files", modPath)
    return configureModPath(modPath, modsDir)
  } else {
    await configureModName(modsDir, modName!)
    return modName!
  }
}

async function configureModPath(modPath: string, modsDir: string): Promise<string> {
  modPath = path.resolve(modPath)
  const infoJsonFile = path.join(modPath, "info.json")
  let infoJson: { name: unknown; version?: unknown }
  try {
    infoJson = JSON.parse(await fsp.readFile(infoJsonFile, "utf8")) as { name: unknown; version?: unknown }
  } catch (e) {
    throw new CliError(`Could not read info.json file from ${modPath}`, { cause: e })
  }
  const modName = infoJson.name
  if (typeof modName !== "string") {
    throw new CliError(`info.json file at ${infoJsonFile} does not contain a string property "name".`)
  }
  const modVersion = typeof infoJson.version === "string" ? infoJson.version : undefined

  // Use a versioned symlink name (e.g. "my-mod_1.2.3") so that fmtk recognises the
  // entry as a valid installed mod and does not remove it when --disableExtra is used.
  // Fall back to the bare mod name if the version is missing.
  const symlinkName = modVersion ? `${modName}_${modVersion}` : modName

  // Remove both the versioned and unversioned entries in case a stale one exists.
  for (const name of [symlinkName, modName]) {
    const p = path.join(modsDir, name)
    const stat = await fsp.lstat(p).catch(() => undefined)
    if (stat) await fsp.rm(p, { recursive: true })
  }

  // Copy mod files into a real directory. A Linux symlink via \\wsl.localhost\ appears
  // as a reparse point to the Windows Factorio executable, which only scans for real
  // directories and zip files and silently skips reparse points.
  const resultPath = path.join(modsDir, symlinkName)
  await copyModFiles(modPath, resultPath)
  return modName
}

// Directories to skip when copying mod files (not part of the mod, just project noise).
const COPY_EXCLUDE_DIRS = new Set(["node_modules", ".git", "FactorioTest", "factorio-test-data-dir"])
// Extensions that Factorio mod files can have.
const MOD_FILE_EXTS = new Set([".lua", ".json", ".png", ".jpg", ".ogg", ".wav", ".cfg", ".txt"])

async function copyModFiles(srcDir: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true })
  const entries = await fsp.readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith(".") || COPY_EXCLUDE_DIRS.has(entry.name)) continue
    const src = path.join(srcDir, entry.name)
    const dest = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      await copyModFiles(src, dest)
    } else if (entry.isFile() && MOD_FILE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      await fsp.copyFile(src, dest)
    }
  }
}

async function configureModName(modsDir: string, modName: string): Promise<void> {
  const exists = await checkModExists(modsDir, modName)
  if (!exists) {
    throw new CliError(`Mod ${modName} not found in ${modsDir}.`)
  }
}

export async function checkModExists(modsDir: string, modName: string): Promise<boolean> {
  const stat = await fsp.stat(modsDir).catch(() => undefined)
  if (!stat?.isDirectory()) return false

  const files = await fsp.readdir(modsDir)
  return files.some((f) => {
    const fileStat = fs.statSync(path.join(modsDir, f), { throwIfNoEntry: false })
    if (fileStat?.isDirectory()) {
      return f === modName || f.match(new RegExp(`^${modName}_\\d+\\.\\d+\\.\\d+$`))
    }
    if (fileStat?.isFile()) {
      return f === modName + ".zip" || f.match(new RegExp(`^${modName}_\\d+\\.\\d+\\.\\d+\\.zip$`))
    }
    return false
  })
}

async function getInstalledModVersion(modsDir: string, modName: string): Promise<string | undefined> {
  const stat = await fsp.stat(modsDir).catch(() => undefined)
  if (!stat?.isDirectory()) return undefined

  const files = await fsp.readdir(modsDir)
  for (const f of files) {
    const fullPath = path.join(modsDir, f)
    const fileStat = fs.statSync(fullPath, { throwIfNoEntry: false })

    if (fileStat?.isDirectory()) {
      if (f === modName) {
        const infoPath = path.join(fullPath, "info.json")
        try {
          const info = JSON.parse(await fsp.readFile(infoPath, "utf8")) as { version?: string }
          if (info.version) return info.version
        } catch {
          continue
        }
      }
      const versionedMatch = f.match(new RegExp(`^${modName}_(\\d+\\.\\d+\\.\\d+)$`))
      if (versionedMatch) {
        const infoPath = path.join(fullPath, "info.json")
        try {
          const info = JSON.parse(await fsp.readFile(infoPath, "utf8")) as { version?: string }
          if (info.version) return info.version
        } catch {
          return versionedMatch[1]
        }
      }
    }

    if (fileStat?.isFile()) {
      const zipMatch = f.match(new RegExp(`^${modName}_(\\d+\\.\\d+\\.\\d+)\\.zip$`))
      if (zipMatch) return zipMatch[1]
    }
  }
  return undefined
}

export async function installFactorioTest(modsDir: string): Promise<void> {
  await fsp.mkdir(modsDir, { recursive: true })
  const playerDataPath = getFactorioPlayerDataPath(path.dirname(modsDir))

  let version = await getInstalledModVersion(modsDir, "factorio-test")

  if (!version) {
    console.log("Downloading mod: factorio-test")
    await runScript("fmtk", "mods", "install", "--modsPath", modsDir, "--playerData", playerDataPath, "factorio-test")
    version = await getInstalledModVersion(modsDir, "factorio-test")
  } else if (compareVersions(version, MIN_FACTORIO_TEST_VERSION) < 0) {
    console.log(`Updating mod: factorio-test (${version} is below minimum ${MIN_FACTORIO_TEST_VERSION})`)
    await runScript(
      "fmtk",
      "mods",
      "install",
      "--force",
      "--modsPath",
      modsDir,
      "--playerData",
      playerDataPath,
      "factorio-test",
    )
    version = await getInstalledModVersion(modsDir, "factorio-test")
  }

  if (!version || compareVersions(version, MIN_FACTORIO_TEST_VERSION) < 0) {
    throw new CliError(
      `factorio-test mod version ${version ?? "unknown"} is below minimum required ${MIN_FACTORIO_TEST_VERSION}`,
    )
  }
}

export async function ensureConfigIni(dataDir: string): Promise<void> {
  const filePath = path.join(dataDir, "config.ini")
  // write-data is read by the Factorio executable, so it must be a Windows
  // path that Factorio can actually write to. On WSL, \\wsl.localhost\ paths
  // are readable by Windows processes but not writable, so we use the real
  // Windows APPDATA Factorio directory instead.
  const appdata = getWindowsAppData()
  const writeData = appdata ? toFactorioPath(path.join(appdata, "Factorio")) : toFactorioPath(dataDir)
  if (!fs.existsSync(filePath)) {
    console.log("Creating config.ini file")
    await fsp.writeFile(
      filePath,
      `; This file was auto-generated by factorio-test cli

[path]
read-data=__PATH__executable__/../../data
write-data=${writeData}

[general]
locale=
`,
    )
  } else {
    const content = await fsp.readFile(filePath, "utf8")
    const newContent = content.replace(/^write-data=.*$/m, `write-data=${writeData}`)
    if (content !== newContent) {
      await fsp.writeFile(filePath, newContent)
    }
  }
}

export interface AutorunOptions {
  verbose?: boolean
  lastFailedTests?: string[]
}

export async function ensureModSettingsDat(
  factorioPath: string,
  dataDir: string,
  modsDir: string,
  verbose?: boolean,
): Promise<void> {
  const settingsDat = path.join(modsDir, "mod-settings.dat")
  if (fs.existsSync(settingsDat)) return

  // On WSL, Factorio (a Windows binary) cannot write to \\wsl.localhost\ paths,
  // so running --create to generate mod-settings.dat fails. Copy it from the
  // Windows Factorio installation instead — fmtk will update the specific settings
  // it needs via `fmtk settings set` immediately after this.
  const appdata = getWindowsAppData()
  if (appdata) {
    const windowsSettingsDat = path.join(appdata, "Factorio", "mods", "mod-settings.dat")
    if (fs.existsSync(windowsSettingsDat)) {
      if (verbose) console.log("Copying mod-settings.dat from Windows Factorio installation (WSL)")
      await fsp.copyFile(windowsSettingsDat, settingsDat)
      return
    }
  }

  if (verbose) console.log("Creating mod-settings.dat file by running factorio")
  const dummySaveFile = path.join(dataDir, "____dummy_save_file.zip")
  await runProcess(
    false,
    factorioPath,
    "--create",
    toFactorioPath(dummySaveFile),
    "--mod-directory",
    toFactorioPath(modsDir),
    "-c",
    toFactorioPath(path.join(dataDir, "config.ini")),
  )

  if (fs.existsSync(dummySaveFile)) {
    await fsp.rm(dummySaveFile)
  }
}

export async function setSettingsForAutorun(
  factorioPath: string,
  dataDir: string,
  modsDir: string,
  modToTest: string,
  mode: "headless" | "graphics",
  options?: AutorunOptions,
): Promise<void> {
  await ensureModSettingsDat(factorioPath, dataDir, modsDir, options?.verbose)
  if (options?.verbose) console.log("Setting autorun settings")
  const autoStartConfig = JSON.stringify({
    mod: modToTest,
    headless: mode === "headless",
    ...(options?.lastFailedTests?.length && { last_failed_tests: options.lastFailedTests }),
  })
  await runScript(
    "fmtk",
    "settings",
    "set",
    "startup",
    "factorio-test-auto-start-config",
    autoStartConfig,
    "--modsPath",
    modsDir,
  )
  await runScript("fmtk", "settings", "unset", "startup", "factorio-test-auto-start", "--modsPath", modsDir)
}

// fmtk only tracks mods it installed (zip files) and won't add a symlinked directory
// to mod-list.json. This function ensures the mod is explicitly enabled in mod-list.json
// regardless of how it was placed in the mods directory.
export async function ensureModEnabled(modsDir: string, modName: string): Promise<void> {
  const modListPath = path.join(modsDir, "mod-list.json")
  let modList: { mods: Array<{ name: string; enabled: boolean }> }
  try {
    modList = JSON.parse(await fsp.readFile(modListPath, "utf8"))
  } catch {
    modList = { mods: [] }
  }

  const existing = modList.mods.find((m) => m.name === modName)
  if (existing) {
    existing.enabled = true
  } else {
    modList.mods.push({ name: modName, enabled: true })
  }

  await fsp.writeFile(modListPath, JSON.stringify(modList, null, 2))
}

export async function resetAutorunSettings(modsDir: string, verbose?: boolean): Promise<void> {
  if (verbose) console.log("Disabling auto-start settings")
  await runScript("fmtk", "settings", "set", "startup", "factorio-test-auto-start-config", "{}", "--modsPath", modsDir)
}

export interface ModRequirement {
  name: string
  minVersion?: string
}

export function parseModRequirement(spec: string): ModRequirement | undefined {
  const trimmed = spec.trim()
  if (trimmed.startsWith("?") || trimmed.startsWith("!") || trimmed.startsWith("(?)")) {
    return undefined
  }
  const withoutPrefix = trimmed.startsWith("~") ? trimmed.slice(1).trim() : trimmed
  const match = withoutPrefix.match(/^(\S+)(?:\s*>=?\s*(\d+\.\d+\.\d+))?/)
  if (!match) return undefined
  const name = match[1]
  if (!name || BUILTIN_MODS.has(name)) return undefined
  return { name, minVersion: match[2] }
}

export function parseRequiredDependencies(dependencies: string[]): ModRequirement[] {
  const result: ModRequirement[] = []
  for (const dep of dependencies) {
    const req = parseModRequirement(dep)
    if (req) result.push(req)
  }
  return result
}

export async function installMods(modsDir: string, mods: ModRequirement[]): Promise<void> {
  const playerDataPath = getFactorioPlayerDataPath(path.dirname(modsDir))

  for (const { name, minVersion } of mods) {
    const installedVersion = await getInstalledModVersion(modsDir, name)

    if (installedVersion) {
      if (!minVersion || compareVersions(installedVersion, minVersion) >= 0) continue
      console.log(`Updating mod: ${name} (${installedVersion} is below required ${minVersion})`)
    } else {
      console.log(`Downloading mod: ${name}`)
    }

    try {
      const args = ["fmtk", "mods", "install", "--modsPath", modsDir, "--playerData", playerDataPath]
      if (installedVersion) args.push("--force")
      args.push(name)
      await runScript(...args)
    } catch {
      console.log(`Could not download mod: ${name}`)
    }
  }
}

export async function installModDependencies(modsDir: string, modPath: string): Promise<string[]> {
  const infoJsonPath = path.join(modPath, "info.json")
  let infoJson: { dependencies?: string[] }
  try {
    infoJson = JSON.parse(await fsp.readFile(infoJsonPath, "utf8")) as { dependencies?: string[] }
  } catch {
    return []
  }

  const dependencies = infoJson.dependencies
  if (!Array.isArray(dependencies)) return []

  const required = parseRequiredDependencies(dependencies)
  await installMods(modsDir, required)

  return required.map((r) => r.name)
}

export interface ModWatchTarget {
  type: "directory" | "file"
  path: string
}

export async function resolveModWatchTarget(
  modsDir: string,
  modPath?: string,
  modName?: string,
): Promise<ModWatchTarget> {
  if (modPath) {
    return { type: "directory", path: path.resolve(modPath) }
  }

  const files = await fsp.readdir(modsDir)
  for (const file of files) {
    const fullPath = path.join(modsDir, file)
    const fileStat = await fsp.lstat(fullPath).catch(() => undefined)
    if (!fileStat) continue

    const isDirectoryMatch =
      fileStat.isDirectory() || fileStat.isSymbolicLink()
        ? file === modName || file.match(new RegExp(`^${modName}_\\d+\\.\\d+\\.\\d+$`))
        : false

    if (isDirectoryMatch) {
      const targetPath = fileStat.isSymbolicLink() ? await fsp.realpath(fullPath) : fullPath
      return { type: "directory", path: targetPath }
    }

    const isFileMatch = fileStat.isFile()
      ? file === modName + ".zip" || file.match(new RegExp(`^${modName}_\\d+\\.\\d+\\.\\d+\\.zip$`))
      : false

    if (isFileMatch) {
      return { type: "file", path: fullPath }
    }
  }

  throw new CliError(`Could not find mod ${modName} in ${modsDir} for watching`)
}
