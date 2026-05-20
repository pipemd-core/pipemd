package db

import (
	"net/http"
	"github.com/gin-gonic/gin"
	"github.com/go-sql-driver/mysql"
)

func ListItems(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"items": []string{}})
}

func CreateItem(c *gin.Context) {
	c.JSON(http.StatusCreated, gin.H{"status": "created"})
}

func Connect() (*mysql.MySQLDriver, error) {
	return nil, nil
}