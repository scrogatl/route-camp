# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-06 15:54:21 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 431d1ad | Garmin trip marks on GPX export, GPX without the track, MyRoute-app Lock Route note
#   2026-11-05 15:57:09 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 5f93c30 | Export Garmin shaping points along the route line
#   2026-11-05 13:50:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | e0f6e37 | Import GPX tracks as routes, de-duplicate re-imports, guard imported lines
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 66d7ed8 | Add GPX parsing, writing and import/export services
# END LICENSE HEADER
"""GPX reading and writing (pure functions, no database access)."""

from dataclasses import dataclass, field

import xml.etree.ElementTree as ET

import gpxpy
from gpxpy.gpx import GPX, GPXRoute, GPXRoutePoint, GPXTrack, GPXTrackPoint, GPXTrackSegment, GPXWaypoint


# Garmin's trip extensions mark each route point as a via point (a stop the device announces) or a shaping
# point (the device routes through it silently). Without them, devices treat every route point as a stop.
TRIP_NS = "http://www.garmin.com/xmlschemas/TripExtensions/v1"
# Garmin's GPX extensions. BaseCamp writes a RoutePointExtension on every route point and a RouteExtension plus a
# trp:Trip on the route; without them a zūmo (and MyRoute-app) can ignore trp:ShapingPoint and make every route
# point a stop the rider has to reach.
GPXX_NS = "http://www.garmin.com/xmlschemas/GpxExtensions/v3"
# No road shape stored between this point and the next: the device calculates the leg itself.
NO_ROAD_SHAPE = "000000000000FFFFFFFFFFFFFFFFFFFFFFFF"


@dataclass
class GpxPoint:
    name: str | None
    lat: float
    lon: float
    desc: str | None = None
    shaping: bool = False  # route points only: a Garmin shaping point rather than a stop


def _is_shaping(point) -> bool:
    return any(ext.tag == f"{{{TRIP_NS}}}ShapingPoint" for ext in point.extensions)


def _route_point_extensions(shaping: bool) -> list[ET.Element]:
    if shaping:
        kind = ET.Element(f"{{{TRIP_NS}}}ShapingPoint")
    else:
        kind = ET.Element(f"{{{TRIP_NS}}}ViaPoint")
        ET.SubElement(kind, f"{{{TRIP_NS}}}CalculationMode").text = "FasterTime"
        ET.SubElement(kind, f"{{{TRIP_NS}}}ElevationMode").text = "Standard"
    point = ET.Element(f"{{{GPXX_NS}}}RoutePointExtension")
    ET.SubElement(point, f"{{{GPXX_NS}}}Subclass").text = NO_ROAD_SHAPE
    return [kind, point]


def _route_extensions() -> list[ET.Element]:
    """Marks the route as a Garmin trip routed for a motorcycle, as BaseCamp writes it."""
    route = ET.Element(f"{{{GPXX_NS}}}RouteExtension")
    ET.SubElement(route, f"{{{GPXX_NS}}}IsAutoNamed").text = "false"
    ET.SubElement(route, f"{{{GPXX_NS}}}DisplayColor").text = "Magenta"
    trip = ET.Element(f"{{{TRIP_NS}}}Trip")
    ET.SubElement(trip, f"{{{TRIP_NS}}}TransportationMode").text = "Motorcycling"
    return [route, trip]


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
            GpxRoute(
                r.name,
                [GpxPoint(p.name, p.latitude, p.longitude, p.description, _is_shaping(p)) for p in r.points],
            )
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
    """Waypoints = unique POIs, rtept = the route's ordered stops (plus any shaping points between them, each
    marked with Garmin's trip extensions), trk = cached calculated line (lat, lon). Leave geometry out for a
    GPS: some turn the track into a trip of their own, with a stop at every track point."""
    gpx = GPX()
    gpx.creator = "route-camp"
    gpx.nsmap["trp"] = TRIP_NS
    gpx.nsmap["gpxx"] = GPXX_NS
    gpx.waypoints = [
        GPXWaypoint(latitude=p.lat, longitude=p.lon, name=p.name, description=p.desc) for p in waypoints
    ]
    route = GPXRoute(name=route_name)
    route.extensions.extend(_route_extensions())
    route.points = []
    for p in route_points:
        point = GPXRoutePoint(latitude=p.lat, longitude=p.lon, name=p.name, description=p.desc)
        point.extensions.extend(_route_point_extensions(p.shaping))
        route.points.append(point)
    gpx.routes.append(route)
    if geometry:
        segment = GPXTrackSegment()
        segment.points = [GPXTrackPoint(latitude=lat, longitude=lon) for lat, lon in geometry]
        track = GPXTrack(name=route_name)
        track.segments.append(segment)
        gpx.tracks.append(track)
    return gpx.to_xml()
