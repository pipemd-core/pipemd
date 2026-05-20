from fastapi import FastAPI
from routers import items_router, auth_router  # noqa: F401

app = FastAPI(title="Fixture API")

app.include_router(items_router, prefix="/items", tags=["items"])
app.include_router(auth_router, prefix="/auth", tags=["auth"])


@app.get("/users")
def list_users():
    return []


@app.get("/users/{user_id}")
def get_user(user_id: int):
    return {"id": user_id}


@app.post("/users")
def create_user():
    return {"id": 1}


@app.put("/users/{user_id}")
def update_user(user_id: int):
    return {"id": user_id}


@app.delete("/users/{user_id}")
def delete_user(user_id: int):
    return {"deleted": user_id}


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.patch("/settings")
def update_settings():
    return {"updated": True}