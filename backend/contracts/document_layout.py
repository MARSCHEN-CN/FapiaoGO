"""坐标模型 BBox（legacy field_extractor 使用）"""


class BBox:
    """轴对齐包围盒"""
    __slots__ = ('_x', '_y', '_width', '_height')

    def __init__(self, x: float = 0, y: float = 0, width: float = 0, height: float = 0):
        self._x = x
        self._y = y
        self._width = width
        self._height = height

    @property
    def x(self) -> float:
        return self._x
    @x.setter
    def x(self, value: float) -> None:
        self._x = value

    @property
    def y(self) -> float:
        return self._y
    @y.setter
    def y(self, value: float) -> None:
        self._y = value

    @property
    def width(self) -> float:
        return self._width
    @width.setter
    def width(self, value: float) -> None:
        self._width = value

    @property
    def height(self) -> float:
        return self._height
    @height.setter
    def height(self, value: float) -> None:
        self._height = value

    @property
    def x0(self) -> float:
        return self._x
    @x0.setter
    def x0(self, value: float) -> None:
        self._width += self._x - value
        self._x = value

    @property
    def y0(self) -> float:
        return self._y
    @y0.setter
    def y0(self, value: float) -> None:
        self._height += self._y - value
        self._y = value

    @property
    def x1(self) -> float:
        return self._x + self._width
    @x1.setter
    def x1(self, value: float) -> None:
        self._width = value - self._x

    @property
    def y1(self) -> float:
        return self._y + self._height
    @y1.setter
    def y1(self, value: float) -> None:
        self._height = value - self._y

    @property
    def cx(self) -> float:
        return self._x + self._width / 2

    @property
    def cy(self) -> float:
        return self._y + self._height / 2
