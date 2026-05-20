package handler

import (
	"go-app/db"
	"github.com/gin-gonic/gin"
)

func RegisterRoutes(r *gin.Engine) {
	r.GET("/items", db.ListItems)
	r.POST("/items", db.CreateItem)
}