from fastapi import APIRouter

router = APIRouter()


@router.get("/")
def list_items():
    return []


@router.get("/{item_id}")
def get_item(item_id: int):
    return {"id": item_id}


@router.post("/")
def create_item():
    return {"id": 1}


@router.put("/{item_id}")
def update_item(item_id: int):
    return {"id": item_id}


@router.delete("/{item_id}")
def delete_item(item_id: int):
    return {"deleted": item_id}