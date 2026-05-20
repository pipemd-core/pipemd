package main

import (
	"fmt"
	"net/http"

	"go-app/handler"
	"github.com/gin-gonic/gin"
)

// TODO: add authentication middleware
func main() {
	r := gin.Default()
	r.GET("/users", getUsers)
	r.POST("/users", createUser)
	handler.RegisterRoutes(r)
	r.Run(":8080")
}

// FIXME: implement proper error handling
func getUsers(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"users": []string{}})
}

func createUser(c *gin.Context) {
	c.JSON(http.StatusCreated, gin.H{"status": "created"})
}

type Handler interface {
	Handle(method string, path string) error
}