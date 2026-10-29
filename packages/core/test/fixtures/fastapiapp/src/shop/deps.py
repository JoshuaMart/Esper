from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import APIKeyHeader, OAuth2PasswordBearer
from sqlalchemy.orm import Session

from shop.models import User

oauth2 = OAuth2PasswordBearer(tokenUrl="/token")
optional_key = APIKeyHeader(name="x-api-key", auto_error=False)


def get_db():
    with Session() as session:
        yield session


SessionDep = Annotated[Session, Depends(get_db)]


class NotSignedIn(Exception):
    pass


def current_user(session: SessionDep, token: Annotated[str, Depends(oauth2)]) -> User:
    user = session.get(User, token)
    if user is None:
        raise NotSignedIn()
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def admin(user: CurrentUser) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admins only")
    return user


def tenant(x_tenant_id: str = Header()) -> str:
    return x_tenant_id
