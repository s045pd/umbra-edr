package api

import (
	"encoding/json"
	"net/http"

	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/db/models"
	"github.com/s045pd/umbra/internal/detect"
)

// ClustersAPI groups endpoints that share a session cookie.
type ClustersAPI struct {
	DB *gorm.DB
}

// List is GET /api/v1/clusters
func (a *ClustersAPI) List(w http.ResponseWriter, r *http.Request) {
	if a.DB == nil {
		JSONErr(w, http.StatusServiceUnavailable, "database not available")
		return
	}
	var bots []models.Bot
	if err := a.DB.Select("id", "name", "cookies").Find(&bots).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	in := make([]detect.BotCookies, 0, len(bots))
	for _, b := range bots {
		raw, _ := json.Marshal(b.Cookies)
		var cookies []map[string]any
		_ = json.Unmarshal(raw, &cookies)
		in = append(in, detect.BotCookies{
			BotID:   b.ID.String(),
			Name:    b.Name,
			Cookies: cookies,
		})
	}
	out := detect.ClusterByCookies(in)
	if out == nil {
		out = []detect.Cluster{}
	}
	JSONOK(w, out)
}
