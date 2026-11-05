from app.optimize import best_order, haversine_time_matrix, path_cost


def test_best_order_walks_a_line_from_the_fixed_start():
    # Four stops on one meridian, listed out of order: start at 0deg, then 1deg, 2deg, 3deg.
    points = [(0.0, 0.0), (0.0, 3.0), (0.0, 1.0), (0.0, 2.0)]
    matrix = haversine_time_matrix(points)
    order = best_order(matrix)
    assert order == [0, 2, 3, 1]
    assert path_cost(order, matrix) <= path_cost([0, 1, 2, 3], matrix)


def test_short_routes_are_left_alone():
    assert best_order([[0.0, 1.0], [1.0, 0.0]]) == [0, 1]
    assert best_order([[0.0]]) == [0]
