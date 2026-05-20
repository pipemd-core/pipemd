from fastapi import APIRouter

router = APIRouter()


@router.post("/login")
def login():
    return {"token": "abc"}


@router.post("/logout")
def logout():
    return {"message": "logged out"}