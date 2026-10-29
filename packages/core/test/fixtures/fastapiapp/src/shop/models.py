from pydantic import BaseModel
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class User(Base):
    is_admin: bool


class Item(Base):
    name: str


class ItemIn(BaseModel):
    name: str
