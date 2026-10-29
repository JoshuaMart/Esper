import subprocess

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text

from shop.deps import CurrentUser, SessionDep, admin, tenant
from shop.models import Item, ItemIn

router = APIRouter(prefix="/items", dependencies=[Depends(tenant)])


@router.get("/")
def list_items(session: SessionDep, user: CurrentUser, q: str | None = Query(default=None, alias="search")):
    return session.execute(text(f"SELECT * FROM items WHERE name LIKE '{q}'"))


@router.get("/{item_id}")
def read_item(item_id: int, session: SessionDep, user: CurrentUser):
    return session.get(Item, item_id)


@router.post("/", dependencies=[Depends(admin)])
def create_item(body: ItemIn, session: SessionDep):
    item = Item(**body.model_dump())
    session.add(item)
    session.commit()
    return item


@router.post("/export")
def export(session: SessionDep, user: CurrentUser, fmt: str = "csv"):
    return subprocess.run(["export", fmt], check=True)


@router.api_route("/sync", methods=["GET", "PUT"])
def sync(user: CurrentUser):
    return {}
