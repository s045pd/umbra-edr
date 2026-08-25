package api

import (
	"crypto/subtle"
	"errors"
	"strings"

	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/s045pd/umbra/internal/db/models"
)

// findBotByCredentials performs one parameterized, bot-scoped credential
// lookup shared by the legacy proxy endpoints and browser snapshot API.
func findBotByCredentials(db *gorm.DB, username, password string) (*models.Bot, error) {
	if db == nil || strings.TrimSpace(username) == "" || password == "" {
		return nil, errors.New("missing credentials")
	}
	var bot models.Bot
	// GORM's normal SQL logger interpolates parameters, so use a silent session
	// for credential lookup and never put the password into the SQL predicate.
	quiet := db.Session(&gorm.Session{Logger: db.Logger.LogMode(logger.Silent)})
	if err := quiet.Where("proxy_username = ?", username).First(&bot).Error; err != nil {
		return nil, err
	}
	if subtle.ConstantTimeCompare([]byte(bot.ProxyPassword), []byte(password)) != 1 {
		return nil, gorm.ErrRecordNotFound
	}
	return &bot, nil
}
