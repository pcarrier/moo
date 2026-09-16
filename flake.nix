{
  description = "moo: a small local agent harness";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Nixpkgs 26.11 dropped Intel macOS; 26.05 still receives security fixes.
    nixpkgs-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    crane.url = "github:ipetkov/crane";
  };

  outputs = { nixpkgs, nixpkgs-darwin, rust-overlay, crane, ... }:
    let
      lib = nixpkgs.lib;
      nixpkgsFor = system:
        if system == "x86_64-darwin" then nixpkgs-darwin else nixpkgs;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = lib.genAttrs systems;

      rustyV8Version = "152.2.0";

      rustyV8Targets = {
        "x86_64-linux" = "x86_64-unknown-linux-gnu";
        "aarch64-linux" = "aarch64-unknown-linux-gnu";
        "x86_64-darwin" = "x86_64-apple-darwin";
        "aarch64-darwin" = "aarch64-apple-darwin";
      };

      rustyV8Hashes = {
        "x86_64-linux" = "sha256-tmg+mvy3f72MssOs9F001SApqyFrMyUiyVF5wS8P7Tw=";
        "aarch64-linux" = "sha256-xAGWu/GCUy5YP2W32vAZb9uzNU5vrFmzHQU5wg+THz0=";
        "x86_64-darwin" = "sha256-BMvBw2xM1UWcVASXddkoiTN8adk2+wsBH5sm8dRUYQ0=";
        "aarch64-darwin" = "sha256-pKVIREStS18Q3HvtFBI23Z2+q/IAbRRSDxm5NdTbQic=";
      };

      harnessDepsHash = "sha256-Fu0cljWip9e4KHOoq/fI835XLFgIQqF7DfjTxD2JbNU=";

      webDepsHash = "sha256-fC09kKs/SKUFPiv6SDutOphZi1J3BoqdZzuOpKPoLwk=";


      # Glibc ABI floor for the portable Linux release.  Covers
      # Ubuntu 20.04+, Debian 11+, RHEL 8+.  Lowering further runs into
      # rusty_v8 syscall references; raise if cargo-zigbuild errors on
      # symbol versions.
      minGlibcVersion = "2.31";
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import (nixpkgsFor system) {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
          };

          rustyV8Target = rustyV8Targets.${system};

          rustyV8Archive = pkgs.fetchurl {
            url = "https://github.com/denoland/rusty_v8/releases/download/v${rustyV8Version}/librusty_v8_release_${rustyV8Target}.a.gz";
            hash = rustyV8Hashes.${system};
          };

          rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;

          craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;

          # Source filter: keep Rust + Cargo + build.rs + the installer pubkey.
          # Web/harness sources are consumed via separate JS-build derivations
          # exposed through env vars, so they don't need to invalidate the rust
          # dep cache.  keys/installer.pub is embedded by upgrade.rs via
          # include_str!, so it must survive the filter or the build can't see it.
          src = lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              (craneLib.filterCargoSources path type)
              || lib.hasSuffix "/build.rs" path
              || lib.hasSuffix "/keys/installer.pub" path;
          };

          # ---- JS artifacts -------------------------------------------------

          # Pre-fetched bun deps for the web bundle.
          webDeps = pkgs.stdenvNoCC.mkDerivation {
            name = "moo-web-node-modules";
            src = lib.cleanSourceWith {
              src = ./web;
              filter = path: _type:
                let base = baseNameOf (toString path);
                in base == "package.json" || base == "bun.lock";
            };
            nativeBuildInputs = [ pkgs.bun pkgs.cacert ];
            dontConfigure = true;
            dontFixup = true;
            buildPhase = ''
              runHook preBuild
              export HOME=$TMPDIR
              # Install optional dependencies for every platform so the
              # resulting node_modules tree is identical across systems. This
              # lets us keep a single webDepsHash instead of one per system.
              bun install --frozen-lockfile --no-progress --cpu '*' --os '*'
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p $out
              cp -R node_modules $out/node_modules
              runHook postInstall
            '';
            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = webDepsHash;
          };

          # Pre-fetched bun deps for the harness bundle.
          harnessDeps = pkgs.stdenvNoCC.mkDerivation {
            name = "moo-harness-node-modules";
            src = lib.cleanSourceWith {
              src = ./harness;
              filter = path: _type:
                let base = baseNameOf (toString path);
                in base == "package.json" || base == "bun.lock";
            };
            nativeBuildInputs = [ pkgs.bun pkgs.cacert ];
            dontConfigure = true;
            dontFixup = true;
            buildPhase = ''
              runHook preBuild
              export HOME=$TMPDIR
              # TypeScript's native compiler has platform-specific packages;
              # include all of them to keep harnessDepsHash portable too.
              bun install --frozen-lockfile --no-progress --cpu '*' --os '*'
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p $out
              cp -R node_modules $out/node_modules
              runHook postInstall
            '';
            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = harnessDepsHash;
          };

          # IIFE harness bundle consumed by the rust embedding step.
          harnessBundle = pkgs.stdenvNoCC.mkDerivation {
            name = "moo-harness-bundle";
            src = lib.cleanSource ./harness;
            nativeBuildInputs = [ pkgs.bun ];
            dontConfigure = true;
            buildPhase = ''
              runHook preBuild
              cp -R ${harnessDeps}/node_modules node_modules
              chmod -R u+w node_modules
              export HOME=$TMPDIR
              bun build src/index.ts --outfile=harness.js --format=iife --target=browser
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              install -Dm644 harness.js $out/harness.js
              runHook postInstall
            '';
          };

          # Vite-built UI (HTML + asset chunks).  Build.rs inlines them.
          webDist = pkgs.stdenvNoCC.mkDerivation {
            name = "moo-web-dist";
            src = lib.cleanSourceWith {
              src = ./.;
              filter = path: type:
                let
                  rel = lib.removePrefix (toString ./. + "/") (toString path);
                in
                  rel == "tsconfig.base.json"
                  || rel == "web"
                  || lib.hasPrefix "web/" rel;
            };
            nativeBuildInputs = [ pkgs.bun pkgs.nodejs ];
            dontConfigure = true;
            buildPhase = ''
              runHook preBuild
              cd web
              cp -R ${webDeps}/node_modules node_modules
              chmod -R u+w node_modules
              patchShebangs node_modules
              export HOME=$TMPDIR
              bun run build
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              cp -R dist $out
              runHook postInstall
            '';
          };

          # ---- Rust builds --------------------------------------------------

          commonArgs = {
            inherit src;
            pname = "moo";
            version = "0.11.0";
            strictDeps = true;
            doCheck = false;

            RUSTY_V8_ARCHIVE = rustyV8Archive;
            MOO_HARNESS_BUNDLE = "${harnessBundle}/harness.js";
            MOO_VITE_DIST = webDist;
          };

          # Dep-only build (cached separately from the workspace build).
          cargoArtifacts = craneLib.buildDepsOnly commonArgs;

          moo = craneLib.buildPackage (commonArgs // {
            inherit cargoArtifacts;
            # On darwin, rewrite /nix/store dylib references to /usr/lib so
            # the binary runs on non-nix Macs.  Bail loudly on unfamiliar
            # libs so we notice when a new dep needs a system mapping.
            postFixup = lib.optionalString pkgs.stdenv.isDarwin ''
              for bin in $out/bin/*; do
                for lib in $(otool -L "$bin" | tail -n +2 | awk '/\/nix\/store\//{print $1}'); do
                  base=$(basename "$lib")
                  case "$base" in
                    libiconv.*|libiconv-*) sys="/usr/lib/libiconv.2.dylib" ;;
                    libz.*|libz-*) sys="/usr/lib/libz.1.dylib" ;;
                    libc++.*) sys="/usr/lib/libc++.1.dylib" ;;
                    libc++abi.*) sys="/usr/lib/libc++abi.dylib" ;;
                    libresolv.*) sys="/usr/lib/libresolv.9.dylib" ;;
                    libSystem.*) sys="/usr/lib/libSystem.B.dylib" ;;
                    *) echo "FATAL: unknown nix-store dylib: $lib"; exit 1 ;;
                  esac
                  echo "rewriting $lib -> $sys"
                  install_name_tool -change "$lib" "$sys" "$bin"
                done
              done
            '';
            meta = {
              description = "Local agent harness with a Rust core, TypeScript runtime, Solid UI, and SQLite memory";
              license = lib.licenses.mit;
              mainProgram = "moo";
              platforms = systems;
            };
          });

          # ---- Portable Linux release via cargo-zigbuild --------------------
          # zig acts as the linker and pins the glibc symbol floor so the
          # binary runs on older distros.  Rusty_v8 prebuilt is glibc-built;
          # this just controls the OUR-code link side.

          mkMooGnu = { glibcVersion }:
            let
              rustTarget = rustyV8Target; # e.g. x86_64-unknown-linux-gnu
              gnuExtra = {
                CARGO_BUILD_TARGET = rustTarget;
                nativeBuildInputs = [
                  pkgs.cargo-zigbuild
                  pkgs.zig
                  pkgs.cmake
                ];
                # aws-lc-sys's cc-rs builder false-positives zig cc on a
                # gcc memcmp bug check; the cmake builder identifies zig
                # cc as clang and works.
                AWS_LC_SYS_CMAKE_BUILDER = "1";
                buildPhaseCargoCommand = "HOME=$TMPDIR cargo zigbuild --release --target ${rustTarget}.${glibcVersion} --locked";
                doNotPostBuildInstallCargoBinaries = true;
              };
              gnuDepsArgs = commonArgs // gnuExtra // { pname = "moo-gnu-deps"; };
              gnuArgs = commonArgs // gnuExtra // {
                pname = "moo-gnu";
                cargoArtifacts = craneLib.buildDepsOnly gnuDepsArgs;
                installPhaseCommand = ''
                  mkdir -p $out/bin
                  cp target/${rustTarget}/release/moo $out/bin/moo
                '';
              };
            in craneLib.buildPackage gnuArgs;

          mooGnu = mkMooGnu { glibcVersion = minGlibcVersion; };

          # Wrap with system-loader interpreter so the artifact is a
          # drop-in tarball binary.
          mooGnuRelease = pkgs.runCommand "moo-gnu-release" {
            nativeBuildInputs = [ pkgs.patchelf ];
          } ''
            mkdir -p $out/bin
            cp ${mooGnu}/bin/moo $out/bin/moo
            chmod +w $out/bin/moo
            patchelf \
              --set-interpreter ${
                if pkgs.stdenv.hostPlatform.isAarch64
                then "/lib/ld-linux-aarch64.so.1"
                else "/lib64/ld-linux-x86-64.so.2"
              } \
              --remove-rpath \
              $out/bin/moo
          '';
        in
        {
          default = moo;
          moo = moo;
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          moo-gnu = mooGnuRelease;
        });

      devShells = forAllSystems (system:
        let
          pkgs = import (nixpkgsFor system) {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
          };
          rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
        in
        {
          default = pkgs.mkShell {
            packages = [
              rustToolchain
              pkgs.bun
              pkgs.cargo-watch
              pkgs.cargo-zigbuild
              pkgs.minisign
              pkgs.nodejs
              pkgs.process-compose
              pkgs.zig
            ];

            shellHook = ''
              if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
                git config core.hooksPath .githooks
              fi
            '';
          };
        });
    };
}
