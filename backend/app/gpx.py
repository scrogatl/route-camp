"""GPX reading and writing (pure functions, no database access)."""

from dataclasses import dataclass, field

import gpxpy
from gpxpy.gpx import GPX, GPXRoute, GPXRoutePoint, GPXTrack, GPXTrackPoint, GPXTrackSegment, GPXWaypoint


@dataclass
class GpxPoint:
    name: str | None
    lat: float
    lon: float
    desc: str | None = None


@dataclass
class GpxRoute:
    name: str | None
    points: list[GpxPoint] = field(default_factory=list)


@dataclass
class GpxTrack:
    name: str | None
    points: list[tuple[float, float]]  # (lat, lon); all segments of the track, in order


@dataclass
class ParsedGpx:
    waypoints: list[GpxPoint] = field(default_factory=list)
    routes: list[GpxRoute] = field(default_factory=list)
    tracks: list[GpxTrack] = field(default_factory=list)


def parse_gpx(data: str | bytes) -> ParsedGpx:
    if isinstance(data, bytes):
        data = data.decode("utf-8-sig")
    gpx = gpxpy.parse(data)
    return ParsedGpx(
        waypoints=[GpxPoint(w.name, w.latitude, w.longitude, w.description) for w in gpx.waypoints],
        routes=[
            GpxRoute(r.name, [GpxPoint(p.name, p.latitude, p.longitude, p.description) for p in r.points])
            for r in gpx.routes
        ],
        tracks=[
            GpxTrack(t.name, [(p.latitude, p.longitude) for segment in t.segments for p in segment.points])
            for t in gpx.tracks
        ],
    )


def build_route_gpx(
    route_name: str,
    waypoints: list[GpxPoint],
    route_points: list[GpxPoint],
    geometry: list[tuple[float, float]] | None = None,
) -> str:
    """Waypoints = unique POIs, rtept = the route's ordered stops, trk = cached calculated line (lat, lon)."""
    gpx = GPX()
    gpx.creator = "route-camp"
    gpx.waypoints = [
        GPXWaypoint(latitude=p.lat, longitude=p.lon, name=p.name, description=p.desc) for p in waypoints
    ]
    route = GPXRoute(name=route_name)
    route.points = [
        GPXRoutePoint(latitude=p.lat, longitude=p.lon, name=p.name, description=p.desc) for p in route_points
    ]
    gpx.routes.append(route)
    if geometry:
        segment = GPXTrackSegment()
        segment.points = [GPXTrackPoint(latitude=lat, longitude=lon) for lat, lon in geometry]
        track = GPXTrack(name=route_name)
        track.segments.append(segment)
        gpx.tracks.append(track)
    return gpx.to_xml()
