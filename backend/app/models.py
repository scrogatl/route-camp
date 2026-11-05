"""SQLAlchemy models.

POIs, routes and plans are stored once and referenced by id. Routes hold an ordered
list of POI references (RouteStop); plans hold an ordered list of route references
(PlanRoute). Tags are many-to-many "folders" attached to any item type.
"""

from datetime import datetime, timezone

from sqlalchemy import JSON, Column, DateTime, Float, ForeignKey, Integer, String, Table, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)


def _tag_link(table_name: str, owner_column: str, owner_table: str) -> Table:
    return Table(
        table_name,
        Base.metadata,
        Column(owner_column, ForeignKey(f"{owner_table}.id", ondelete="CASCADE"), primary_key=True),
        Column("tag_id", ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
    )


poi_tags = _tag_link("poi_tags", "poi_id", "pois")
route_tags = _tag_link("route_tags", "route_id", "routes")
plan_tags = _tag_link("plan_tags", "plan_id", "plans")


class POI(Base):
    __tablename__ = "pois"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    notes: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    tags: Mapped[list[Tag]] = relationship(secondary=poi_tags, order_by=Tag.name, lazy="selectin")


class Route(Base):
    __tablename__ = "routes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    notes: Mapped[str | None] = mapped_column(Text, default=None)
    profile: Mapped[str] = mapped_column(String(20), default="car")
    # Cached GraphHopper result, cleared whenever the stops or profile change.
    distance_m: Mapped[float | None] = mapped_column(Float, default=None)
    time_s: Mapped[float | None] = mapped_column(Float, default=None)
    geometry: Mapped[list | None] = mapped_column(JSON, default=None)  # [[lon, lat], ...]
    calculated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    stops: Mapped[list["RouteStop"]] = relationship(
        back_populates="route",
        order_by="RouteStop.position",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    tags: Mapped[list[Tag]] = relationship(secondary=route_tags, order_by=Tag.name, lazy="selectin")

    def invalidate(self) -> None:
        self.distance_m = None
        self.time_s = None
        self.geometry = None
        self.calculated_at = None


class RouteStop(Base):
    __tablename__ = "route_stops"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    route_id: Mapped[int] = mapped_column(ForeignKey("routes.id", ondelete="CASCADE"), index=True)
    poi_id: Mapped[int] = mapped_column(ForeignKey("pois.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer)

    route: Mapped[Route] = relationship(back_populates="stops")
    poi: Mapped[POI] = relationship(lazy="selectin")


class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    notes: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    route_links: Mapped[list["PlanRoute"]] = relationship(
        order_by="PlanRoute.position",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    tags: Mapped[list[Tag]] = relationship(secondary=plan_tags, order_by=Tag.name, lazy="selectin")


class PlanRoute(Base):
    __tablename__ = "plan_routes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    route_id: Mapped[int] = mapped_column(ForeignKey("routes.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer)

    route: Mapped[Route] = relationship(lazy="selectin")
